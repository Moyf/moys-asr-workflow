import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, copyFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {buildToolDocs, collectDocuments, documentationAsset, vendors, projectRoot} from '../scripts/build-tool-docs.mjs';

const baseUrl = 'file:///repo/tools/example/README.md';
async function rendererHarness() {
  const window = {};
  runInNewContext(await readFile('tools/shared/vendor/marked-18.1.3/marked.umd.js', 'utf8'), {window, globalThis:window});
  // Node checks Marked output and sanitizer delegation only. Actual DOMPurify safety is browser-tested.
  let lastOptions;
  window.DOMPurify = {sanitize(html, options) {lastOptions = options; return html;}};
  runInNewContext(await readFile('tools/shared/markdown.js', 'utf8'), {window, URL, document:{baseURI:baseUrl}});
  return {api:window.MAWMarkdown, options:() => lastOptions};
}

test('Marked parses Chinese GFM, nesting, fenced languages and collision-safe heading IDs', async () => {
  const {api, options} = await rendererHarness();
  const html = api.render('# 中文标题\n\n# 中文标题\n\n# 中文标题-1\n\n# 中文标题\n\n- 一级\n  - 二级 **强调**\n- [x] 已核验\n\n| 列 | 值 |\n| --- | --- |\n| 中 | 文 |\n\n```js\nconst x = "<img>";\n```\n\n[回标题](#中文标题)');
  assert.match(html, /id="maw-md-中文标题"/);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*<strong>强调<\/strong>/);
  assert.match(html, /type="checkbox"/); assert.match(html, /disabled/);
  assert.match(html, /<table>/); assert.match(html, /class="language-js"/); assert.match(html, /&lt;img&gt;/);
  assert.match(html, /href="#maw-md-/);
  assert.equal(options().RETURN_DOM_FRAGMENT, true);
  assert.ok(options().ALLOWED_TAGS.includes('mark'));
  for (const tag of ['img','svg','iframe','script','style']) assert.ok(!options().ALLOWED_TAGS.includes(tag));
});

test('highlight inline tokenizer preserves escapes, code and malformed delimiters; disabled extension is negative control', async () => {
  const {api} = await rendererHarness();
  const markdown = '==中文 **粗体**== 与 ==*斜体*==\n\n`==代码==`\n\n```txt\n==围栏==\n```\n\n\\==转义==\n\n====\n\n==未闭合\n\n==跨\n行==';
  const html = api.render(markdown);
  assert.match(html, /<mark>中文 <strong>粗体<\/strong><\/mark>/);
  assert.match(html, /<mark><em>斜体<\/em><\/mark>/);
  assert.equal([...html.matchAll(/<mark>/g)].length, 2);
  for (const text of ['==代码==','==围栏==','==转义==','====','==未闭合','==跨\n行==']) assert.ok(html.includes(text), text);
  const without = api.render(markdown, {highlight:false});
  assert.ok(!without.includes('<mark>'));
  assert.ok(without.includes('<strong>粗体</strong>'));
  console.log('Negative highlight control: same input yields mark with extension, no mark without; strong remains.');
});

test('unsafe URLs and raw HTML never become active Marked output, including inside highlight', async () => {
  const {api} = await rendererHarness();
  for (const url of ['javascript:alert(1)','data:text/html,test','vbscript:evil','jav%61script:evil','%64ata:text/html,x','javascript%3Aevil','file:///secret','https://user:pass@example.com','https://example.com/\nfoo','&#106;avascript:evil','javascript&colon;evil','java&Tab;script:evil','%26%23106%3Bavascript:evil','java%09script:evil']) {
    assert.equal(api.resolveUrl(url, baseUrl), null, url);
  }
  const html = api.render('==<img src="https://evil.invalid/x" onerror="alert(1)"> [恶链](javascript:evil)==\n\n![图](https://example.com/x.png)\n\n[文档](../README.md)\n\n[外链](https://example.com/安全)');
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /&lt;img/); assert.match(html, /图片未自动加载/);
  assert.match(html, /file:\/\/\/repo\/tools\/README.md/);
  assert.match(html, /rel="nofollow noopener noreferrer"/);
});

test('renderer fails clearly when local security libraries are missing', async () => {
  const window = {};
  runInNewContext(await readFile('tools/shared/markdown.js', 'utf8'), {window, URL, document:{baseURI:baseUrl}});
  assert.throws(() => window.MAWMarkdown.render('text'), /Local Marked and DOMPurify/);
});

test('strict consumers can require absolute URLs and disable even explicit image-opening links', async () => {
  const {api} = await rendererHarness();
  for (const href of ['README.md','../doc.md','#标题','//example.com/path']) assert.equal(api.resolveUrl(href, baseUrl, {absoluteOnly:true}), null);
  assert.equal(api.resolveUrl('https://example.com/path', baseUrl, {absoluteOnly:true}).href, 'https://example.com/path');
  const html = api.render('[本地](README.md) [绝对](https://example.com) ![图片](https://example.com/image.png)', {absoluteOnly:true,noImages:true});
  assert.ok(!html.includes('file:///')); assert.ok(!html.includes('image.png')); assert.ok(!html.includes('打开图片'));
  assert.ok(html.includes('此视图禁用图片入口')); assert.ok(html.includes('https://example.com/'));
});

test('extension handles escaped equal signs without using them as a closing delimiter', async () => {
  const {api} = await rendererHarness();
  assert.match(api.render('==中文\\==仍在高亮=='), /<mark>中文==仍在高亮<\/mark>/);
  assert.ok(!api.render('==中文\\==').includes('<mark>'));
});

test('highlight closing delimiter respects Marked code spans and link/image tokens', async () => {
  const {api} = await rendererHarness();
  for (const markdown of [
    '==before `==literal==` after==',
    '==before ``code ` ==literal==`` after==',
    '==before **`==literal==`** after==',
    '==before [链接](https://example.com/?q===value==) after==',
    '==before ![图片](https://example.com/?q===value==) after==',
  ]) {
    const html = api.render(markdown);
    assert.equal([...html.matchAll(/<mark>/g)].length, 1, markdown);
    assert.ok(html.includes(' after</mark>'), markdown);
  }
  assert.match(api.render('==before `==literal==` after=='), /<code>==literal==<\/code>/);
  assert.ok(!api.render('==before `==literal==` after').includes('<mark>'));
  assert.ok(!api.render('==before [链接](https://example.com/?q===value==) after').includes('<mark>'));
  assert.ok(!api.render('==before `==literal==` after==', {highlight:false}).includes('<mark>'));
});

test('file URL policy rejects rooted, drive, UNC and encoded variants; ordinary relative traversal remains a link', async () => {
  const {api} = await rendererHarness();
  for (const href of ['/C:/private/secret.txt','/etc/passwd','\\private\\secret.txt','\\\\server\\share\\secret.txt',
    'C:/private/secret.txt','C:\\private\\secret.txt','//server/share','%2fetc/passwd','%5cprivate','%252fetc/passwd',
    '%43%3a/private/secret.txt','%2fC%3a/private/secret.txt','.%5c..%5cprivate','file:///secret']) {
    assert.equal(api.resolveUrl(href, baseUrl), null, href);
    assert.ok(!api.render(`[文件](${href})`, {baseUrl}).includes('<a '), href);
  }
  assert.equal(api.resolveUrl('../README.md', baseUrl).href, 'file:///repo/tools/README.md');
  assert.equal(api.resolveUrl('../../docs/schema.md', baseUrl).href, 'file:///repo/docs/schema.md');
  assert.equal(api.resolveUrl('/path', 'https://example.com/docs/README.md').href, 'https://example.com/path');
});

test('offline resolver only returns bundled documents and never fetches', async () => {
  const window = {};
  runInNewContext(await readFile('tools/shared/doc-data.js', 'utf8'), {window, URL});
  const store = window.MAWToolDocData.create({baseUrl:'file:///repo/tools/index.html', data:{documents:{'shared/README.md':{text:'说明',format:'markdown'}}}});
  assert.equal(store.resolve('shared/README.md#标题').hash, '#%E6%A0%87%E9%A2%98');
  assert.equal(store.resolve('../docs/README.md'), null);
  assert.equal(store.resolve('https://example.com/shared/README.md'), null);
  assert.equal(store.resolve('shared/README.md?x=1'), null);
  assert.equal(store.load(store.resolve('shared/README.md')).text, '说明');
  assert.throws(() => store.load({path:'missing.md'}), /未收录/);
});

test('generated text is frozen data; document edits fail freshness and --write restores it', async () => {
  const text = await documentationAsset();
  const window = {};
  runInNewContext(text, {window});
  assert.ok(Object.isFrozen(window.MAWToolDocs.documents));
  assert.equal(window.MAWToolDocs.documents['merge-flow.mjs'].format, 'source');
  assert.ok(!text.includes('</script'));
  const documents = await collectDocuments();
  assert.ok(Object.keys(documents).every(path => !path.startsWith('../')));
  await mkdir('.artifacts/tool-markdown', {recursive:true});
  const fixture = await mkdtemp(resolve('.artifacts/tool-markdown/freshness-'));
  for (const path of ['catalog.js', ...Object.keys(documents)]) {
    const destination = resolve(fixture, 'tools', path); await mkdir(dirname(destination), {recursive:true});
    await copyFile(resolve(projectRoot, 'tools', path), destination);
  }
  for (const vendor of vendors) {
    for (const [,name] of vendor.files) {
      const path = `tools/shared/vendor/${vendor.name}-${vendor.version}/${name}`;
      const destination = resolve(fixture, path); await mkdir(dirname(destination), {recursive:true});
      await copyFile(resolve(projectRoot, path), destination);
    }
  }
  await buildToolDocs({root:fixture, write:true});
  await buildToolDocs({root:fixture});
  await writeFile(resolve(fixture, 'tools/shared/README.md'), '# 已修改\n\n</script>\n');
  await assert.rejects(buildToolDocs({root:fixture}), /Stale tool documentation assets/);
  await buildToolDocs({root:fixture, write:true});
  await buildToolDocs({root:fixture});
  const vendorPath = resolve(fixture, 'tools/shared/vendor/marked-18.1.3/marked.umd.js');
  const official = await readFile(vendorPath);
  await writeFile(vendorPath, 'not official bytes');
  await assert.rejects(buildToolDocs({root:fixture}), /Unexpected official vendor bytes/);
  await writeFile(vendorPath, official);
  await buildToolDocs({root:fixture});
  console.log('Negative freshness control: document edit rejected; --write restored. Fixture: ' + fixture);
});

test('vendored distributions and complete licenses match official SHA256 and installed packages when present', async () => {
  for (const vendor of vendors) for (const [source, target, hash] of vendor.files) {
    const bytes = await readFile(`tools/shared/vendor/${vendor.name}-${vendor.version}/${target}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    const installed = await readFile(`node_modules/${vendor.name}/${source}`).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (installed) assert.deepEqual(bytes, installed);
  }
});
