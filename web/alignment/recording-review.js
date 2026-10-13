/* Recording review extension; existing take UI remains the only selection surface. */
window.MAWRecordingReview = (() => {
  let context, serial = 0, busy = false, confirmed = {}, enabled = false;
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
    try { localStorage.setItem(key(), JSON.stringify(request())); }
    catch (_) { el('recording-status').textContent = '本机存储不可用；请先保存审查工程。'; }
  }
  function renderReview(result) {
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
    el('recording-generate').disabled=busy||!result.review.ready;
    if(!busy)el('recording-status').textContent=result.review.ready
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
    } catch(error) { if(revision===serial)el('recording-status').textContent=error.message; }
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
    for(const id of ['recording-source','recording-latest','recording-recommend','recording-fill'])el(id).disabled=running;
    el('recording-lines').querySelectorAll('input').forEach(input=>input.disabled=running);
  }
  async function generate(mode = 'start') {
    controls(true);el('recording-generate').disabled=true;save();
    try {
      await post(mode,request());
      while(busy) {
        await new Promise(resolve=>setTimeout(resolve,400));
        const response=await fetch('/api/recording/status');
        const result=await response.json();
        el('recording-status').textContent=result.message || result.status;
        if(result.status==='complete') {
          el('recording-status').textContent=(mode==='fill'?'已补码，请用此新工程重新打开口播审查：':'已生成，请听审：')+
            '\nMOSP：'+result.artifact.projectPath+
            (result.artifact.srtPath?'\nSRT：'+result.artifact.srtPath:'')+
            (result.artifact.reportPath?'\n报告：'+result.artifact.reportPath:'');
          break;
        }
        if(result.status!=='running')break;
      }
    } catch(error) {el('recording-status').textContent=error.message;}
    finally {controls(false);}
  }
  function mount(callbacks) {
    context=callbacks;
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
        context.apply(stored);confirmed=stored.confirmedByLine||{};
        el('recording-source').checked=stored.sourceConfirmed===true;
        el('recording-latest').checked=stored.preferLatest===true;
        el('recording-enable').checked=true;el('recording-body').hidden=false;enabled=true;
      }
    } catch (_) {}
  }
  return {mount, refresh, snapshot:request};
})();
