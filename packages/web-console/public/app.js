const app = document.getElementById('app');
let principal, project, demo = false, view = 'overview', reports = [], defects = [], suggestions = [], metrics = {}, p0 = {enabled:false,alerts:[],assessments:[]};
const names = { candidate: '待复核', open: '待处理', investigating: '调查中', fixed: '已修复', verified: '已验证', dismissed: '已忽略', merged: '已合并', reviewing: '评审中', accepted: '已接受', planned: '已计划', in_progress: '进行中', implemented: '已实现', declined: '已拒绝', archived: '已归档', pending_remote: '等待 GitHub', succeeded: '已完成', unknown: '结果未知', blocked: '权限阻塞', prepared: '等待发送', safe_retry: '等待安全重试' };
const actions = { investigate: '开始调查', fix: '标记修复', verify: '验证完成', reopen: '重新打开', dismiss: '忽略', review: '开始评审', accept: '接受建议', plan: '加入计划', start: '开始实现', implement: '标记已实现', decline: '拒绝建议', archive: '归档' };
const navItems = [['overview', '◈', '总览'], ['reports', '▤', '报告归档'], ['defect', '◇', 'Bug'], ['suggestion', '✧', '建议'], ['attachments','▧','附件关联'], ['p0','!','P0 告警'], ['sources', '⌁', '来源与投递']];
function el(tag, attrs = {}, ...children) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on'))
        n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class')
        n.className = v;
    else if (k === 'value')
        n.value = v;
    else
        n.setAttribute(k, v);
} for (const child of children.flat())
    if (child !== null && child !== undefined)
        n.append(child instanceof Node ? child : document.createTextNode(String(child))); return n; }
const button = (label, fn, style = 'secondary') => el('button', { class: style, type: 'button', onClick: fn }, label);
const tag = (label, type = '') => el('span', { class: `tag ${type}` }, label);
function notice(message) { const n = document.getElementById('toast'); n.textContent = message; n.style.display = 'block'; setTimeout(() => { n.style.display = 'none'; }, 5000); }
const csrf = () => document.cookie.split('; ').find(c => c.startsWith('sa_csrf='))?.split('=')[1] ?? '';
const errors = { WORK_VERSION_CONFLICT: '状态已变化，请刷新后重新操作。', REPORT_REVISION_CONFLICT: '已有更新的报告修订，请返回归档查看。', TOKEN_EXPIRED_OR_USED: '操作凭据已过期，请重新打开详情。', FORBIDDEN: '当前账号没有执行此操作的权限。', CSRF_INVALID: '会话校验失效，请重新登录。', RATIONALE_REQUIRED: '请先填写处理理由。', REPORT_WINDOW_NOT_DUE: '该窗口尚未结束，或仍在等待分析宽限期。', STATUS_TRANSITION_NOT_ALLOWED: '当前状态不支持此操作，请刷新详情。' };
async function api(path, body) { const response = await fetch(path + (path.includes('?') ? '&' : '?') + `project=${encodeURIComponent(project ?? '')}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) {
    if (response.status === 401)
        login();
    throw new Error(errors[data.error] ?? '请求未完成，请刷新页面或查看来源与投递状态。');
} return data; }
function localTime(value) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
function short(id) { return id?.length > 20 ? id.slice(0, 12) + '…' + id.slice(-5) : id; }
function login() { principal = null; app.replaceChildren(el('div', { class: 'login-wrap' }, el('form', { class: 'login-card', onSubmit: async (event) => { event.preventDefault(); const key = document.getElementById('access-key'); const error = document.getElementById('login-error'); try {
        const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey: key.value }) });
        const data = await response.json();
        key.value = '';
        if (!response.ok)
            throw new Error('访问密钥无效，请核对后重试。');
        principal = data.principal;
        demo = data.demo;
        project = principal.projects[0];
        await load();
    }
    catch (e) {
        error.textContent = e.message;
    } } }, el('div', { class: 'brand' }, el('span', { class: 'mark' }, 'S'), 'SuperAgent'), el('h1', {}, '回到反馈发生的地方'), el('p', { class: 'subtitle' }, '将社区声音，变成清晰的产品行动。'), el('label', { for: 'access-key' }, '工作空间访问密钥'), el('input', { id: 'access-key', type: 'password', autocomplete: 'off', required: '', placeholder: '输入访问密钥' }), el('button', { class: 'primary', type: 'submit' }, '进入工作台 →'), el('p', { id: 'login-error', class: 'error', role: 'alert' }), el('p', { class: 'login-foot' }, '私有工作空间 · 仅授权成员可访问')))); }
async function load() { try {
    [reports, defects, suggestions, metrics, p0] = await Promise.all([api('/api/reports'), api('/api/works/defect'), api('/api/works/suggestion'), api('/api/metrics'), api('/api/p0')]);
    render();
}
catch (e) {
    notice(e.message);
} }
function shell(content) { app.replaceChildren(el('div', { class: 'shell' }, el('aside', { class: 'sidebar' }, el('div', { class: 'brand' }, el('span', { class: 'mark' }, 'S'), 'SuperAgent'), el('div', { class: 'brand-caption' }, 'COMMUNITY INTELLIGENCE'), el('div', { class: 'nav-label' }, '工作空间'), el('nav', { class: 'nav' }, navItems.map(([id, icon, label]) => el('button', { class: view === id ? 'active' : '', type: 'button', onClick: () => { view = id; render(); } }, el('span', { class: 'nav-icon' }, icon), label))), el('div', { class: 'sidebar-foot' }, el('div', {}, el('span', { class: 'dot' }), '私有工作空间'), el('div', {}, '18:00 / 00:00 · 北京时间'))), el('div', { class: 'workspace' }, el('header', { class: 'topbar' }, el('select', { class: 'project', 'aria-label': '选择项目', onChange: async (event) => { project = event.target.value; await load(); } }, principal.projects.map(p => el('option', { value: p, ...(p === project ? { selected: '' } : {}) }, p))), el('div', { class: 'account' }, demo ? tag('演示数据', 'amber') : null, el('span', {}, principal.role === 'developer' ? '开发者' : '只读成员'), el('span', { class: 'avatar' }, principal.actorRef.slice(0, 1).toUpperCase()), button('退出', async () => { await api('/api/logout', {}); login(); }, 'plain'))), el('main', { class: 'main' }, content)))); }
function head(titleText, subtitle, action) { return el('div', { class: 'page-head' }, el('div', {}, el('div', { class: 'eyebrow' }, 'COMMUNITY / WORKSPACE'), el('h1', {}, titleText), el('p', { class: 'subtitle' }, subtitle)), action ?? null); }
function panel(titleText, body, extra) { return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, titleText), extra ?? null), body); }
function render() { if (!principal)
    return login(); if (view === 'overview')
    overview();
else if (view === 'reports')
    reportList();
else if (view === 'defect' || view === 'suggestion')
    workList(view);
else if(view === 'p0')
    p0List();
else if(view==='attachments')
    attachmentList();
else
    sources();
if(view==='sources'){
  const state=metrics.embeddings??{state:'disabled',consecutiveFailures:0};
  document.querySelector('.main').append(panel('语义检索',el('div',{class:'panel-body'},
    el('p',{},({disabled:'未启用，使用词法检索',idle:'等待索引',available:'接口可用',unavailable:'接口暂不可用，已退回词法检索'})[state.state]??state.state),
    el('p',{class:'muted'},`连续失败 ${state.consecutiveFailures??0}`,state.lastSuccessAt?` · 最近成功 ${localTime(state.lastSuccessAt)}`:'',state.retryAt?` · 下次尝试 ${localTime(state.retryAt)}`:''))));
} }
async function attachmentList(cursor){try{
 const page=await api('/api/attachments'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(view!=='attachments')return;
 const cards=page.items.map(row=>{const select=el('select',{'aria-label':'关联反馈'},el('option',{value:''},'选择反馈'),row.candidates.map(c=>el('option',{value:c.feedbackItemId,...(row.feedback_item_id===c.feedbackItemId?{selected:''}:{})},`${c.kind==='defect'?'Bug':'建议'} · ${c.title}`))),reason=el('input',{'aria-label':'关联理由',placeholder:'填写确认或拒绝理由',maxlength:'2000'});
 const submit=async reject=>{try{if(!reject&&!select.value)return notice('请先选择一条反馈。');const request={eventId:row.event_id,assetRef:row.asset_ref,feedbackItemId:reject?null:select.value,expectedVersion:row.version,reason:reason.value};const {token}=await api('/api/attachments/review-token',request);await api('/api/attachments/review',{request,token});notice('附件关联已更新，反馈数量保持不变。');await attachmentList(cursor);}catch(e){notice(e.message);}};
 return panel(({pending:'等待可关联反馈',review:'需要确认归属',confirmed:'已关联',rejected:'已拒绝'})[row.status]??row.status,el('div',{class:'panel-body'},el('p',{},row.source||'这条消息没有文字内容。'),el('p',{class:'muted'},`${row.file?.mime_type??'附件'} · ${row.file?.size??'尚未保存'}${row.file?.size?' 字节':''} · ${row.file?.state??'等待捕获'}`),el('p',{class:'muted'},row.method==='reply'?'通过引用回复关联':row.method==='same_author_window'?'同会话前后 5 分钟的反馈候选，需核对发送者和内容':row.method==='same_message'?'同一消息的反馈':row.method==='manual'?'人工处理：'+row.reason:'附件内容尚未分析'),...(row.publications??[]).map(p=>el('p',{class:'muted'},`GitHub ${p.repository}：${({waiting_configuration:'等待配置文件上传会话',published:'已发布',unknown:'结果未知，未重传',blocked:'已阻塞，请检查权限或上传结果',pending:'等待发布',uploaded:'等待核验',safe_retry:'等待有限重试'})[p.state]??p.state}`)),row.file?.state==='stored'?el('a',{href:`/api/artifacts/${encodeURIComponent(row.file.artifact_id)}?project=${encodeURIComponent(project)}`},'下载原附件'):null,principal.role==='developer'?el('div',{class:'button-row'},select,reason,button('确认关联',()=>submit(false),'primary'),button('拒绝关联',()=>submit(true))):null));});
 shell([head('附件关联','确认分开发送的截图、日志和文件属于哪条反馈。关联不会增加独立反馈数。',button('刷新',()=>attachmentList(cursor))),...cards,...(!cards.length?[el('div',{class:'empty'},'暂无附件。')]:[]),...(page.nextCursor?[button('下一页',()=>attachmentList(page.nextCursor))]:[])]);
}catch(e){notice(e.message);}}
function overview() { const pending = (metrics.queue ?? []).filter(j => ['pending', 'leased', 'running', 'retry_wait', 'dead_letter'].includes(j.status) && j.kind.includes('triage')).reduce((n, j) => n + j.count, 0); const latest = reports[0]; const cards = [['待处理 Bug', defects.filter(w => ['open', 'candidate', 'investigating'].includes(w.status)).length, '保留证据，持续跟进', '◇'], ['产品建议', suggestions.length, '从玩家诉求到产品决策', '✧'], ['等待分析', pending, '任务状态独立展示', '⌁'], ['报告快照', reports.length, '每一版均可回溯', '▤']]; shell([head('社区反馈总览', '让每一条有价值的反馈，都有清晰的去向。', button('↻ 刷新数据', load)), el('div', { class: 'stats' }, cards.map(([label, value, note, icon]) => el('div', { class: 'stat' }, el('span', { class: 'stat-icon' }, icon), el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value), el('div', { class: 'stat-note' }, note)))), el('div', { class: 'cols' }, el('div', {}, panel('最近一期报告', el('div', { class: 'panel-body' }, latest ? el('div', { class: 'report-cover' }, el('div', { class: 'report-label' }, 'COMMUNITY FEEDBACK DIGEST'), el('h2', {}, `${localTime(latest.window.endExclusive)} 半日报`), el('div', { class: 'report-meta' }, `${localTime(latest.window.startInclusive)} — ${localTime(latest.window.endExclusive)} · 修订 ${latest.revision}`), el('div', { class: 'mini-stats' }, [['Bug', latest.counts.uniqueDefects], ['建议', latest.counts.uniqueSuggestions], ['Steam 差评', latest.steamNegativeReviews.length], ['待分析', latest.counts.pendingAnalysis]].map(([label, n]) => el('div', {}, el('strong', {}, n), el('span', {}, label)))), el('div', { class: 'button-row' }, button('打开报告 →', () => openReport(latest), 'primary'))) : el('div', { class: 'empty' }, '还没有封存的报告。', el('br'), '报告将在固定窗口结束后生成。'), latest?.coverage.some(c => c.status !== 'full') ? el('div', { class: 'notice' }, '部分来源覆盖不完整，当前统计不代表全部社区反馈。') : null), tag('已封存', 'green')), panel('需要关注的 Bug', workTable(defects.slice(0, 5), 'defect'), button('查看全部 →', () => { view = 'defect'; render(); }, 'plain'))), el('div', {}, panel('来源覆盖', el('div', { class: 'panel-body' }, sourceRows())), panel('工作节奏', el('div', { class: 'panel-body' }, el('h3', {}, '北京时间 18:00 / 00:00'), el('p', { class: 'muted' }, '报告按固定窗口归档。晚到分析进入新的修订，旧报告保持原样。'), el('div', { class: 'notice' }, '待分析不等于没有反馈；没有接入的来源不参与完整性判断。')))))]); }
function sourceRows() { return (metrics.sources ?? []).length ? metrics.sources.map(s => el('div', { class: 'source-row' }, el('div', { class: 'source-icon' }, s.platform.includes('qq') ? 'QQ' : s.platform.includes('steam') ? 'ST' : 'DC'), el('div', { class: 'source-text' }, el('strong', {}, s.source_id), el('small', {}, s.platform)), tag(({ full: '完整', partial: '部分覆盖', unknown: '尚未确认', unavailable: '未连接' })[s.coverage], s.coverage === 'full' ? 'green' : 'amber'))) : el('div', { class: 'empty' }, '尚未配置来源'); }
function workTable(rows, kind) {
    if (!rows.length)
        return el('div', { class: 'empty' }, '当前没有匹配的反馈条目。');
    const headers = el('thead', {}, el('tr', {}, ['反馈条目', '状态', '来源反馈', '复核'].map(value => el('th', {}, value))));
    const body = el('tbody', {}, rows.map(w => el('tr', {}, el('td', {}, el('button', { class: 'title-button', onClick: () => openWork(kind, w.id) }, w.title), el('span', { class: 'sub-id' }, short(w.id))), el('td', {}, tag(names[w.status] ?? w.status, ['fixed', 'verified'].includes(w.status) ? 'green' : 'blue')), el('td', {}, w.feedbackCount), el('td', {}, w.reviewRequired ? tag('需要复核', 'amber') : el('span', { class: 'muted' }, '—')))));
    return el('div', { class: 'table-wrap' }, el('table', {}, headers, body));
}
function workList(kind, rows = kind === 'defect' ? defects : suggestions) { shell([head(kind === 'defect' ? 'Bug 跟进' : '产品建议', kind === 'defect' ? '查看问题状态、证据与处理进展。' : '独立记录玩家诉求，保留产品决策轨迹。'), panel(kind === 'defect' ? '问题列表' : '建议列表', workTable(rows, kind), el('form', { onSubmit: async (e) => { e.preventDefault(); try {
            const found = await api(`/api/works/${kind}?q=${encodeURIComponent(e.target.query.value)}`);
            workList(kind, found);
        }
        catch (error) {
            notice(error.message);
        } } }, el('input', { class: 'search', name: 'query', placeholder: '搜索标题或描述', 'aria-label': '搜索反馈' })))]); }
function reportList() { shell([head('报告归档', '固定窗口，不可变快照。每一版都保留当时的结论与证据。', principal.role === 'developer' ? button('生成最近已结束窗口', async () => { try {
        await api('/api/reports/generate', {});
        await load();
        notice('报告已封存');
    }
    catch (e) {
        notice(e.message);
    } }, 'primary') : null), el('div', { class: 'list' }, reports.length ? reports.map(r => el('article', { class: 'report-row' }, el('div', {}, tag(`修订 ${r.revision}`, 'green'), el('h3', {}, `${localTime(r.window.endExclusive)} 社区反馈半日报`), el('div', { class: 'muted' }, `${localTime(r.window.startInclusive)} — ${localTime(r.window.endExclusive)} · Bug ${r.counts.uniqueDefects} / 建议 ${r.counts.uniqueSuggestions} / 待分析 ${r.counts.pendingAnalysis}`)), button('查看快照 →', () => openReport(r)))) : el('div', { class: 'empty' }, '报告尚未生成。'))]); }
async function openReport(report, section = 'bugs', cursor) { try {
    const prefix = `/api/reports/${encodeURIComponent(report.reportId)}/${report.revision}`;
    const [page, rendered] = await Promise.all([api(`${prefix}/section?section=${section}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`), api(`${prefix}/content`)]);
    const content = el('div', { class: 'report-content' });
    // HTML comes only from the authenticated server's allowlisted Markdown renderer.
    content.innerHTML = rendered.html;
    shell([head('社区反馈半日报', `${localTime(report.window.startInclusive)} — ${localTime(report.window.endExclusive)} · 修订 ${report.revision} · 已封存`, button('← 返回归档', () => { view = 'reports'; render(); })), panel('报告摘要', el('div', { class: 'panel-body' }, content)), el('section', { class: 'panel' }, el('div', { class: 'tabs' }, [['bugs', 'Bug'], ['suggestions', '建议'], ['steam_negative_reviews', 'Steam 差评']].map(([id, label]) => button(label, () => openReport(report, id), id === section ? 'active' : ''))), el('div', { class: 'panel-body' }, el('p', { class: 'snapshot-note' }, page.coverageWarning), page.entries.length ? page.entries.map(entry => entry.kind === 'steam_negative_review' ? el('article', { class: 'evidence' }, el('div', { class: 'evidence-meta' }, 'Steam 评价 · ' + localTime(entry.occurredAt)), el('pre', { class: 'original' }, entry.originalText)) : el('article', { class: 'report-row' }, el('div', {}, el('h3', {}, entry.title), el('p', { class: 'muted' }, `本期反馈 ${entry.newFeedbackCount}${entry.status ? ' · 快照状态 ' + (names[entry.status] ?? entry.status) : ''}`)), button('查看原文与当前进展', () => openWork(entry.kind === 'bug' ? 'defect' : 'suggestion', entry.id, report)))) : el('div', { class: 'empty' }, '此修订没有该栏目成员。'), page.nextCursor ? button('下一页 →', () => openReport(report, section, page.nextCursor)) : null)), principal.role === 'developer' ? button('生成新修订（保留当前版本）', async () => { try {
            const req = { reportId: report.reportId, revision: report.revision };
            const { token } = await api('/api/reports/revise-token', req);
            const fresh = await api('/api/reports/revise', { ...req, token });
            notice(`修订 ${fresh.revision} 已归档，未额外推送`);
            reports = await api('/api/reports');
            await openReport(fresh);
        }
        catch (e) {
            notice(e.message);
        } }) : null]);
}
catch (e) {
    notice(e.message);
} }
async function openWork(kind, id, report, cursor) { try {
    const w = await api(`/api/works/${kind}/${encodeURIComponent(id)}`);
    const evidence = await api(`/api/works/${kind}/${encodeURIComponent(id)}/evidence?${report ? `reportId=${encodeURIComponent(report.reportId)}&revision=${report.revision}&` : ''}${cursor ? 'cursor=' + encodeURIComponent(cursor) : ''}`);
    shell([head(w.title, `${kind === 'defect' ? 'Bug' : '建议'} · 版本 ${w.version}${report ? ' · 原文固定于报告修订 ' + report.revision : ''}`, button('← 返回', () => report ? openReport(report) : render())), el('div', { class: 'detail-grid' }, panel(`来源原文 · ${evidence.total} 条`, el('div', { class: 'panel-body' }, evidence.items.length ? evidence.items.map(e => el('article', { class: 'evidence' }, el('div', { class: 'evidence-meta' }, e.platform, e.createdAt ? localTime(e.createdAt) : '', e.visible ? '原文' : '不可见'), el('pre', { class: 'original' }, e.originalText))) : el('div', { class: 'empty' }, '暂无可展示的原文。'), evidence.nextCursor ? button('下一页原文 →', () => openWork(kind, id, report, evidence.nextCursor)) : null)), panel('当前处理状态', el('div', { class: 'panel-body' }, tag(names[w.status] ?? w.status, 'green'), el('p', { class: 'detail-summary' }, w.summary), el('p', { class: 'muted' }, `独立来源对象 ${w.feedbackCount} · 当前版本 ${w.version}`), w.reviewRequired ? el('div', { class: 'notice' }, '该条目仍需要人工复核。') : null, principal.role === 'developer' ? el('div', {}, el('label', { class: 'muted', for: 'rationale' }, '处理理由（拒绝或忽略时必填）'), el('textarea', { class: 'rationale', id: 'rationale', placeholder: '记录处理依据，便于后续回溯' }), el('div', { class: 'action-list' }, w.allowedActions.map(action => button(actions[action] ?? action, async () => { try {
            const request = { kind, id, action, expectedVersion: w.version, ...(document.getElementById('rationale').value.trim() ? { rationale: document.getElementById('rationale').value.trim() } : {}) };
            const { token } = await api('/api/actions/token', request);
            const result = await api('/api/actions', { request, token, interactionId: crypto.randomUUID() });
            notice(result.state === 'pending_remote' ? '已提交，等待 GitHub 确认；当前状态尚未改变。' : '状态已更新并记录');
            [defects,suggestions,metrics]=await Promise.all([api('/api/works/defect'),api('/api/works/suggestion'),api('/api/metrics')]);
            await openWork(kind, id, report);
        }
        catch (e) {
            notice(e.message);
        } })))) : el('p', { class: 'muted' }, '当前账号仅可查看。'))))]);
    const main=document.querySelector('.main');
    if(kind==='defect'&&p0.enabled&&principal.role==='developer'){
      const reason=el('textarea',{class:'rationale','aria-label':'P0 确认理由',placeholder:'说明核实的影响与证据，必填'});
      const impact=el('select',{'aria-label':'P0 影响'},[['irreversible_save_loss','不可恢复的存档丢失'],['account_compromise','账号被接管'],['service_unavailable','全体玩家服务中断']].map(([value,label])=>el('option',{value},label)));
      const execute=async action=>{try{const {token}=await api('/api/p0/token',{issueId:id,expectedVersion:w.version,action,impact:impact.value,reason:reason.value});await api('/api/p0/actions',{token});p0=await api('/api/p0');notice('P0 决策已归档；发送结果请查看 P0 告警。');await openWork(kind,id,report);}catch(error){notice(error.message);}};
      main.append(panel('P0 影响核实',el('div',{class:'panel-body'},
        el('p',{class:'muted'},'仅对核实的严重影响确认 P0；同一事件重复确认不会重发。重新告警将创建新代次。'),impact,reason,
        el('div',{class:'action-list'},button('确认 P0',()=>execute('confirm')),button('结束事件',()=>execute('resolve')),button('明确重新告警',()=>execute('realert'))))));
    }
    const history=await api(`/api/works/${kind}/${encodeURIComponent(id)}/history`);
    main.append(panel('处理记录 · 最近 100 条',el('div',{class:'panel-body'},history.length?history.map(h=>el('article',{class:'evidence'},el('div',{class:'evidence-meta'},localTime(h.createdAt),h.actorRef),el('p',{},actions[h.details?.action]??({'analysis_applied':'反馈分析','manual_relink':'关联纠正','manual_merge':'合并条目','remote_status':'GitHub 状态同步','developer_status':'状态操作'}[h.action]??h.action)),h.details?.from?el('p',{class:'muted'},`${names[h.details.from]??h.details.from} → ${names[h.details.to]??h.details.to}`):null,h.details?.reason||h.details?.rationale?el('p',{},h.details.reason??h.details.rationale):null)):el('p',{class:'muted'},'暂无处理记录。'))));
    if(w.mergedInto)main.append(el('div',{class:'notice'},'该条目已合并。',button('查看合并后的条目',()=>openWork(kind,w.mergedInto))));
    else if(principal.role==='developer')main.append(panel('关联纠错',el('div',{class:'panel-body'},el('p',{class:'muted'},'移动反馈、拆分误聚类或合并重复条目。操作保留原文和审计，不改写旧报告。'),button('打开关联纠错',()=>correctionForm(w)))));
}
catch (e) {
    notice(e.message);
} }
async function correctionForm(work){
  try{
    const [items,targets]=await Promise.all([api(`/api/works/${work.kind}/${encodeURIComponent(work.id)}/items`),api(`/api/works/${work.kind}`)]);
    const alternatives=targets.filter(w=>w.id!==work.id);const itemSelect=el('select',{class:'search',id:'correction-item','aria-label':'选择反馈项'},items.map(i=>el('option',{value:i.feedbackItemId},`${i.title} · ${short(i.feedbackItemId)}`)));
    const targetSelect=el('select',{class:'search',id:'correction-target','aria-label':'目标条目'},alternatives.map(w=>el('option',{value:w.id},w.title)));
    const reason=el('textarea',{class:'rationale',id:'correction-reason',placeholder:'请填写纠错理由','aria-label':'纠错理由'});
    const submit=async action=>{try{const target=alternatives.find(w=>w.id===targetSelect.value);const request={kind:work.kind,id:work.id,action,expectedVersion:work.version,reason:reason.value,...(action!=='merge'?{feedbackItemId:itemSelect.value}:{}),...(action!=='split'&&target?{targetId:target.id,targetVersion:target.version}:{})};const {token}=await api('/api/corrections/token',request);const result=await api('/api/corrections',{request,token,interactionId:crypto.randomUUID()});[defects,suggestions]=await Promise.all([api('/api/works/defect'),api('/api/works/suggestion')]);notice('关联已更正，原文和旧报告均已保留。');await openWork(work.kind,result.workId);}catch(e){notice(e.message);}};
    shell([head('纠正反馈关联',work.title,button('← 返回详情',()=>openWork(work.kind,work.id))),panel('选择反馈与目标',el('div',{class:'panel-body'},el('p',{class:'muted'},'单条移动或拆分请选择反馈项；合并会保留两边全部原文。'),el('p',{},el('label',{for:'correction-item'},'反馈项'),el('br'),itemSelect),el('p',{},el('label',{for:'correction-target'},'目标条目'),el('br'),targetSelect),reason,el('div',{class:'action-list'},button('移动该反馈',()=>submit('move')),button('拆为新条目',()=>submit('split')),button('合并到目标条目',()=>submit('merge')))))]);
  }catch(e){notice(e.message);}
}
function p0List(){
  const labels={pending:'等待发送',sending:'发送中',accepted:'接口已受理',blocked:'未获发送权限',rejected:'接口拒绝',unknown:'结果未知，禁止自动重发',manual_review:'需要人工核对'};
  shell([head('P0 告警','严重影响经证据核实后单独归档。接口受理不代表已读。',button('↻ 刷新数据',load)),
    !p0.enabled?el('div',{class:'notice'},'即时告警当前未启用；历史记录仍可查看。'):null,
    panel('告警历史',el('div',{class:'panel-body'},p0.alerts.length?p0.alerts.map(a=>el('article',{class:'evidence'},button(a.title,()=>openWork('defect',a.issue_id),'plain'),el('p',{},`代次 ${a.alert_generation} · ${a.incident_state==='active'?'事件进行中':'事件已结束'} · ${labels[a.delivery_status]??'等待建立投递记录'}`),el('p',{class:'muted'},localTime(a.detected_at),a.last_error?` · ${a.last_error}`:''),el('pre',{class:'original'},a.markdown))):el('p',{class:'muted'},'暂无 P0 告警。'))),
    panel('证据复核',el('div',{class:'panel-body'},p0.assessments.length?p0.assessments.map(a=>el('article',{class:'evidence'},button(short(a.issue_id),()=>openWork('defect',a.issue_id),'plain'),el('p',{},`${a.status}${a.error_code?' · '+a.error_code:''}`),a.result_json?el('p',{},JSON.parse(a.result_json).assessment?.rationale??''):null)):el('p',{class:'muted'},'暂无需要复核的严重影响线索。')))]);
}
function sources() { shell([head('来源与投递', '覆盖范围、队列和发送结果分别记录。'), el('div', { class: 'cols' }, panel('来源状态', el('div', { class: 'panel-body' }, sourceRows())), panel('对外操作', el('div', { class: 'panel-body' }, (metrics.operations ?? []).length ? metrics.operations.map(o => el('div', { class: 'source-row' }, el('div', { class: 'source-text' }, names[o.state] ?? o.state), tag(String(o.count), o.state === 'succeeded' ? 'green' : 'amber'))) : el('div', { class: 'empty' }, '暂无对外操作。')))), panel('任务队列', el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '任务'), el('th', {}, '状态'), el('th', {}, '数量'))), el('tbody', {}, (metrics.queue ?? []).map(q => el('tr', {}, el('td', {}, q.kind), el('td', {}, q.status), el('td', {}, q.count))))))), metrics.pendingCommands?.length ? panel('等待外部确认的操作', el('div', { class: 'panel-body' }, metrics.pendingCommands.map(c => el('div', { class: 'source-row' }, el('span', { class: 'source-text' }, short(c.command_id)), tag(names[c.state] ?? c.state, 'amber'))))) : null]); }
(async () => { try {
    const response = await fetch('/api/session');
    if (!response.ok)
        return login();
    const data = await response.json();
    principal = data.principal;
    demo = data.demo;
    project = principal.projects[0];
    await load();
}
catch {
    login();
} })();
