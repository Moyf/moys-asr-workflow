/* Recording review extension; existing take UI remains the only selection surface. */
window.MAWRecordingReview = (() => {
  let context, serial = 0, busy = false, confirmed = {}, enabled = false;
  let ready = false, sourceValid = false, polling = null, terminalMessage = "", lastDigest = "";
  const el = id => document.getElementById(id);
  function key() { return 'maw.recording.review.v1.' + context.state().recordingInputSignature; }
  function request() {
    const data = context.selection();
    for (const [line, id] of Object.entries(confirmed)) {
      if (data.selectedByLine[line] !== id) delete confirmed[line];
    }
    return {...data, inputSignature: context.state().recordingInputSignature,
      requestToken: context.state().requestToken, sourceConfirmed: el('recording-source').checked,
      preferLatest: el('recording-latest').checked, confirmedByLine: {...confirmed}};
  }
  async function post(path, body) {
    const response = await fetch('/api/recording/' + path, {method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '文稿审查失败');
    return result;
  }
  function save() {
    try {
      const {requestToken, ...snapshot} = request();
      localStorage.setItem(key(), JSON.stringify(snapshot));
    }
    catch (_) { el('recording-status').textContent = '本机存储不可用；请先保存审查工程。'; }
  }
  function renderReview(result) {
    if(lastDigest&&lastDigest!==result.review.selectionDigest)terminalMessage="";
    lastDigest=result.review.selectionDigest;
    const root=el('recording-lines');root.replaceChildren();
    for (const line of result.review.lines) {
      const row=document.createElement('div');row.className='recording-row';
      const text=document.createElement('p');
      text.textContent=line.lineId + ' · ' + line.text + '\nASR：' + (line.sourceText || '未选') +
        (line.reasons.length ? '\n' + line.reasons.join('；') : '\n选声与文稿对应');
      row.append(text);
      if (line.candidateId) {
        const label=document.createElement('label'), input=document.createElement('input');
        input.type='checkbox';input.dataset.lineId=line.lineId;
        input.checked=confirmed[line.lineId]===line.candidateId;input.disabled=busy;
        input.addEventListener('change',()=>{
          if(input.checked)confirmed[line.lineId]=line.candidateId;else delete confirmed[line.lineId];
          void refresh();
        });
        label.append(input,document.createTextNode(' 已试听，确认这一次完整念读；有差异是 ASR 听写错误'));
        row.append(label);
      }
      root.append(row);
    }
    ready=result.review.ready;
    sourceValid=result.recommendations.evidenceErrors.length===0;
    controls(busy);
    if(!busy&&!terminalMessage)el('recording-status').textContent=result.review.ready
      ? '可生成文稿字幕；额外内容仍按当前选择保留。'
      : result.review.blockers.map(b=>(b.lineId?b.lineId+'：':'')+b.reason).join('\n');
  }
  async function refresh() {
    if(!context||!enabled)return;
    const revision=++serial;
    el('recording-generate').disabled=true;
    try {
      const result=await post('review',request());
      if(revision!==serial)return;
      renderReview(result);save();
    } catch(error) { if(revision===serial) { ready=false; controls(busy); el('recording-status').textContent=error.message; } }
  }
  async function recommend() {
    try {
      const result=await post('review',request());
      context.apply({...context.selection(),selectedByLine:result.recommendations.recommendedSelection});
      confirmed={};await context.preview();await refresh();
    } catch(error) {el('recording-status').textContent=error.message;}
  }
  function controls(running) {
    busy=running;el('recording-cancel').disabled=!running;
    el('recording-enable').disabled=running;
    el('recording-generate').disabled=running||!ready;
    for(const id of ['recording-source','recording-latest','recording-recommend','recording-fill'])el(id).disabled=running;
    el('recording-fill').disabled=running||!sourceValid;
    el('recording-lines').querySelectorAll('input').forEach(input=>input.disabled=running);
  }
  function showStatus(result) {
    let message=result.message||result.status;
    if(result.status==='complete'&&result.artifact) {
      message=(result.operation==='fill'?'已补码，请用此新工程重新打开口播审查：':'已生成，请听审：')+
        '\nMOSP：'+result.artifact.projectPath+
        (result.artifact.srtPath?'\nSRT：'+result.artifact.srtPath:'')+
        (result.artifact.reportPath?'\n报告：'+result.artifact.reportPath:'');
    }
    if(result.status!=='running'&&result.status!=='idle')terminalMessage=message;
    el('recording-status').textContent=message;
  }
  async function poll(initial) {
    if(polling)return polling;
    polling=(async()=>{
      try {
        let result=initial;
        while(result.status==='running') {
          showStatus(result);
          await new Promise(resolve=>setTimeout(resolve,400));
          const response=await fetch('/api/recording/status');
          if(!response.ok)throw new Error('读取生成状态失败；请重新打开审查页。');
          result=await response.json();
        }
        showStatus(result);
      } catch(error) {terminalMessage=error.message;el('recording-status').textContent=error.message;}
      finally {controls(false);polling=null;}
    })();
    return polling;
  }
  async function generate(mode = 'start') {
    terminalMessage='';controls(true);save();
    try {await poll(await post(mode,request()));}
    catch(error) {terminalMessage=error.message;el('recording-status').textContent=error.message;controls(false);}
  }
  async function resume() {
    try {
      const response=await fetch('/api/recording/status');
      if(!response.ok)return;
      const result=await response.json();
      if(result.status==='running') {
        enabled=true;el('recording-enable').checked=true;el('recording-body').hidden=false;
        controls(true);void poll(result);
      } else if(enabled&&result.status!=='idle'&&(!result.selectionDigest||result.selectionDigest===lastDigest))showStatus(result);
    } catch(error) {if(enabled)el('recording-status').textContent=error.message;}
  }
  function mount(callbacks) {
    context=callbacks;
    let restored=false;
    el('recording-enable').addEventListener('change',event=>{
      enabled=event.target.checked;el('recording-body').hidden=!enabled;void refresh();
    });
    el('recording-source').addEventListener('change',()=>void refresh());
    el('recording-latest').addEventListener('change',()=>void refresh());
    el('recording-recommend').addEventListener('click',()=>void recommend());
    el('recording-generate').addEventListener('click',()=>void generate());
    el('recording-fill').addEventListener('click',()=>void generate('fill'));
    el('recording-cancel').addEventListener('click',()=>void post('cancel',request()).catch(error=>{
      el('recording-status').textContent=error.message;
    }));
    try {
      const stored=JSON.parse(localStorage.getItem(key())||'null');
      if(stored&&stored.inputSignature===context.state().recordingInputSignature) {
        context.apply(stored);confirmed=stored.confirmedByLine||{};restored=true;
        el('recording-source').checked=stored.sourceConfirmed===true;
        el('recording-latest').checked=stored.preferLatest===true;
        el('recording-enable').checked=true;el('recording-body').hidden=false;enabled=true;
      }
    } catch (_) {}
    return restored;
  }
  return {mount, refresh, resume, snapshot:request};
})();
