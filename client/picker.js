// webToAgent 圈選工具：圈選元素 → 記住修改需求 → 確認後整批送到 CLI
(() => {
  if (window.__wtaLoaded) return;
  window.__wtaLoaded = true;

  const activeKey = 'wta-active';
  const queueKey = 'wta-queue';
  const maxItems = 50;
  const gap = 8;
  const labelH = 22;
  // proxy 模式 (Vue / React dev server) 畫面更新交給 HMR，不連 SSE 自動重新整理
  const proxyMode = document.currentScript?.dataset.wtaMode === 'proxy';
  const state = { active: false, locked: null, editIndex: -1, hovered: null, rafId: 0, queue: readQueue() };

  injectStyle();
  const ui = buildUi();
  bindEvents();
  if (!proxyMode) connectReload();
  if (readActive()) setActive(true);
  renderQueue();

  // ---------- functions ----------

  function injectStyle() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/__wta/picker.css';
    document.head.append(link);
  }

  function buildUi() {
    const root = document.createElement('div');
    root.className = 'wta-root';
    root.innerHTML = `
      <div class="wta-marks"></div>
      <div class="wta-box" hidden><span class="wta-label"></span></div>
      <form class="wta-panel" hidden>
        <div class="wta-panel-head">
          <span class="wta-target"></span>
          <button type="button" class="wta-close" aria-label="取消">×</button>
        </div>
        <textarea class="wta-input" rows="3" placeholder="想怎麼改？例：字體放大、改成主色（Enter 記住，Shift+Enter 換行）"></textarea>
        <div class="wta-actions">
          <button type="button" class="wta-btn wta-btn-danger wta-remove" hidden>刪除</button>
          <button type="button" class="wta-btn wta-btn-ghost wta-cancel">取消</button>
          <button type="submit" class="wta-btn wta-btn-primary wta-save">記住修改</button>
        </div>
      </form>
      <div class="wta-dock">
        <button type="button" class="wta-toggle" title="圈選模式（Alt+Shift+E）">✎ 圈選</button>
        <button type="button" class="wta-submit" hidden>確認送出</button>
      </div>
      <div class="wta-toast" hidden></div>
    `;
    document.body.append(root);
    return {
      root,
      marks: root.querySelector('.wta-marks'),
      box: root.querySelector('.wta-box'),
      label: root.querySelector('.wta-label'),
      panel: root.querySelector('.wta-panel'),
      target: root.querySelector('.wta-target'),
      input: root.querySelector('.wta-input'),
      remove: root.querySelector('.wta-remove'),
      save: root.querySelector('.wta-save'),
      toggle: root.querySelector('.wta-toggle'),
      submit: root.querySelector('.wta-submit'),
      toast: root.querySelector('.wta-toast')
    };
  }

  function bindEvents() {
    ui.toggle.addEventListener('click', () => setActive(!state.active));
    ui.submit.addEventListener('click', submitQueue);
    ui.root.querySelector('.wta-close').addEventListener('click', unlock);
    ui.root.querySelector('.wta-cancel').addEventListener('click', unlock);
    ui.remove.addEventListener('click', removeItem);
    ui.panel.addEventListener('submit', (e) => {
      e.preventDefault();
      saveItem();
    });
    ui.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        saveItem();
      }
    });

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    window.addEventListener('resize', schedulePosition, { passive: true });
  }

  function isOwnElement(el) {
    return el instanceof Element && ui.root.contains(el);
  }

  function onMouseMove(e) {
    if (!state.active || state.locked) return;
    const el = e.target;
    if (!(el instanceof Element) || isOwnElement(el) || el === document.documentElement) return;
    state.hovered = el;
    drawBox(el);
  }

  function onClick(e) {
    if (!state.active || isOwnElement(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (state.locked) return;
    const el = e.target;
    if (!(el instanceof Element) || el === document.documentElement) return;
    lock(el);
  }

  function onKeyDown(e) {
    if (e.altKey && e.shiftKey && e.code === 'KeyE') {
      e.preventDefault();
      setActive(!state.active);
      return;
    }
    if (e.key !== 'Escape' || !state.active) return;
    if (state.locked) unlock();
    else setActive(false);
  }

  function setActive(on) {
    state.active = on;
    ui.toggle.classList.toggle('wta-on', on);
    ui.toggle.textContent = on ? '✎ 圈選中' : '✎ 圈選';
    document.documentElement.classList.toggle('wta-picking', on);
    writeActive(on);
    if (!on) {
      unlock();
      ui.box.hidden = true;
    }
  }

  // 鎖定元素；若已在待送清單中，帶出原本內容供修改或刪除
  function lock(el) {
    const selector = buildSelector(el);
    state.locked = el;
    state.editIndex = state.queue.findIndex((item) => item.page === location.pathname && item.selector === selector);
    const editing = state.editIndex >= 0;
    ui.box.classList.add('wta-locked');
    ui.target.textContent = editing ? `#${state.editIndex + 1} ${describe(el)}` : describe(el);
    ui.input.value = editing ? state.queue[state.editIndex].instruction : '';
    ui.save.textContent = editing ? '更新修改' : '記住修改';
    ui.remove.hidden = !editing;
    ui.panel.hidden = false;
    drawBox(el);
    positionPanel();
    ui.input.focus();
  }

  function unlock() {
    state.locked = null;
    state.editIndex = -1;
    ui.panel.hidden = true;
    ui.box.classList.remove('wta-locked');
    ui.box.hidden = true;
  }

  function saveItem() {
    const instruction = ui.input.value.trim();
    if (!instruction || !state.locked) return;
    const el = state.locked;
    if (state.editIndex >= 0) {
      state.queue[state.editIndex].instruction = instruction;
      showToast(`已更新第 ${state.editIndex + 1} 筆修改`);
    } else {
      if (state.queue.length >= maxItems) {
        showToast(`最多記住 ${maxItems} 筆，請先確認送出`, true);
        return;
      }
      state.queue.push({
        page: location.pathname,
        selector: buildSelector(el),
        label: describe(el),
        outerHTML: el.outerHTML.slice(0, 2000),
        text: (el.textContent || '').trim().slice(0, 300),
        computed: pickComputed(el),
        source: detectSource(el),
        instruction
      });
      showToast(`已記住第 ${state.queue.length} 筆修改`);
    }
    writeQueue();
    unlock();
    renderQueue();
  }

  function removeItem() {
    if (state.editIndex < 0) return;
    const no = state.editIndex + 1;
    state.queue.splice(state.editIndex, 1);
    writeQueue();
    unlock();
    renderQueue();
    showToast(`已刪除第 ${no} 筆修改`);
  }

  async function submitQueue() {
    if (!state.queue.length) return;
    unlock();
    ui.submit.disabled = true;
    try {
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: state.queue.map((item) => ({ ...item, viewport })) })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
      const count = state.queue.length;
      state.queue = [];
      writeQueue();
      renderQueue();
      showToast(`已送出 ${count} 筆修改到 CLI（${data.batchId}）`);
    } catch (err) {
      showToast(`送出失敗：${err.message}`, true);
    } finally {
      ui.submit.disabled = false;
    }
  }

  // 更新「確認送出 (N)」按鈕與頁面上的編號徽章
  function renderQueue() {
    const count = state.queue.length;
    ui.submit.hidden = count === 0;
    ui.submit.textContent = `確認送出 (${count})`;
    ui.marks.replaceChildren();
    state.queue.forEach((item, i) => {
      if (item.page !== location.pathname) return;
      const mark = document.createElement('div');
      mark.className = 'wta-mark';
      mark.innerHTML = `<span class="wta-mark-no">${i + 1}</span>`;
      mark.dataset.selector = item.selector;
      ui.marks.append(mark);
    });
    positionMarks();
  }

  function positionMarks() {
    ui.marks.querySelectorAll('.wta-mark').forEach((mark) => {
      let el = null;
      try {
        el = document.querySelector(mark.dataset.selector);
      } catch {
        el = null;
      }
      mark.hidden = !el;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      Object.assign(mark.style, {
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });
    });
  }

  function drawBox(el) {
    const rect = el.getBoundingClientRect();
    Object.assign(ui.box.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    ui.label.textContent = describe(el);
    ui.label.classList.toggle('wta-label-inside', rect.top < 24);
    ui.box.hidden = false;
  }

  function schedulePosition() {
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      positionMarks();
      const el = state.locked || (state.active && state.hovered);
      if (!el || !el.isConnected) return;
      drawBox(el);
      if (state.locked) positionPanel();
    });
  }

  // 下方空間足夠放下方，否則放上方，兩邊都不夠就貼齊視窗底部
  function positionPanel() {
    const rect = state.locked.getBoundingClientRect();
    const panelH = ui.panel.offsetHeight;
    const panelW = ui.panel.offsetWidth;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let top;
    if (vh - rect.bottom >= panelH + gap) top = rect.bottom + gap;
    else if (rect.top >= panelH + gap + labelH) top = rect.top - panelH - gap - labelH;
    else top = vh - panelH - gap;
    // 元素捲出畫面時，面板仍保持在視窗內可見
    top = Math.min(Math.max(top, gap), Math.max(vh - panelH - gap, gap));
    const left = Math.min(Math.max(rect.left, gap), Math.max(vw - panelW - gap, gap));
    ui.panel.style.top = `${top}px`;
    ui.panel.style.left = `${left}px`;
  }

  function pickComputed(el) {
    const cs = getComputedStyle(el);
    const keys = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'margin', 'padding', 'display', 'width', 'height'];
    return Object.fromEntries(keys.map((k) => [k, cs[k]]));
  }

  // 產生唯一 selector：遇到唯一 id 即停止，否則以 tag + nth-of-type 往上組
  function buildSelector(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.localName === 'body') break;
      node = parent;
    }
    return parts.join(' > ');
  }

  // 找出元素屬於哪個元件原始檔 (只在開發模式有效)，找不到回傳 null
  function detectSource(el) {
    try {
      return vueSource(el) || reactSource(el);
    } catch {
      return null;
    }
  }

  // Vue：優先用 vite-plugin-vue-inspector 的位置資訊 (檔案:行:欄)，沒有再從元件實例取 __file
  function vueSource(el) {
    const instance = findVueInstance(el);
    const component = instance ? vueComponentName(instance) : null;
    const usedIn = instance ? vueUsedIn(instance) : null;
    const match = String(findInspectorData(el) || '').match(/^(.+?):(\d+):(\d+)$/);
    if (match) return { framework: 'vue', file: match[1], line: Number(match[2]), component, usedIn };
    if (!instance) return null;
    for (let node = instance; node; node = node.parent) {
      if (node.type && node.type.__file) return { framework: 'vue', file: node.type.__file, line: null, component: vueComponentName(node), usedIn };
    }
    return { framework: 'vue', file: null, line: null, component, usedIn };
  }

  // 元件在父層模板中被使用的位置 (props 從這裡傳入)；根元件沒有父層時回傳 null
  function vueUsedIn(instance) {
    const parent = instance.parent;
    if (!parent) return null;
    const props = instance.vnode && instance.vnode.props;
    const match = String((props && props.__v_inspector) || '').match(/^(.+?):(\d+):(\d+)$/);
    if (match) return { file: match[1], line: Number(match[2]), component: vueComponentName(parent) };
    if (parent.type && parent.type.__file) return { file: parent.type.__file, line: null, component: vueComponentName(parent) };
    return null;
  }

  // 新版 inspector 會把 data-v-inspector 從 DOM 移到 vnode.props.__v_inspector，舊版則留在屬性上
  function findInspectorData(el) {
    for (let node = el; node; node = node.parentElement) {
      const props = node.__vnode && node.__vnode.props;
      if (props && props.__v_inspector) return props.__v_inspector;
      if (node.hasAttribute('data-v-inspector')) return node.getAttribute('data-v-inspector');
    }
    return null;
  }

  function findVueInstance(el) {
    for (let node = el; node; node = node.parentElement) {
      if (node.__vueParentComponent) return node.__vueParentComponent;
    }
    return null;
  }

  function vueComponentName(instance) {
    const type = instance.type || {};
    const name = type.name || type.__name;
    if (name) return name;
    return type.__file ? type.__file.split('/').pop().replace(/\.vue$/, '') : null;
  }

  // React：從 __reactFiber$ 取得 fiber；React 18 以前用 _debugSource，React 19 改從 _debugStack 推出檔案
  function reactSource(el) {
    let fiber = null;
    for (let node = el; node && !fiber; node = node.parentElement) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      if (key) fiber = node[key];
    }
    if (!fiber) return null;
    const component = reactComponentName(fiber);
    const usedIn = reactUsedIn(fiber._debugOwner);
    return { framework: 'react', ...reactFiberLocation(fiber), component, usedIn };
  }

  // 寫出這段 JSX 的元件 (owner) 在父層被使用的位置；owner 由 createRoot 直接渲染 (沒有父層元件) 時回傳 null
  function reactUsedIn(owner) {
    if (!owner || !owner._debugOwner) return null;
    const location = reactFiberLocation(owner);
    if (!location.file) return null;
    return { ...location, component: reactComponentName(owner) };
  }

  // fiber 對應的 JSX 位置：React 18 以前用 _debugSource，React 19 改從 _debugStack 推出檔案
  function reactFiberLocation(fiber) {
    const debugSource = fiber._debugSource;
    if (debugSource && debugSource.fileName) return { file: debugSource.fileName, line: debugSource.lineNumber || null };
    const file = fiber._debugStack ? fileFromStack(String(fiber._debugStack.stack || '')) : null;
    return { file, line: null };
  }

  // 往上找第一個有名稱的 function / class 元件 (優先用 _debugOwner，即寫出這段 JSX 的元件)
  function reactComponentName(fiber) {
    for (let node = fiber._debugOwner || fiber.return; node; node = node._debugOwner || node.return) {
      const type = node.type;
      if (!type) continue;
      const fn = typeof type === 'function' ? type : type.render || type.type;
      const name = type.displayName || (fn && (fn.displayName || fn.name));
      if (name) return name;
    }
    return null;
  }

  // React 19 開發模式的 JSX 呼叫堆疊：取第一個不在 node_modules / Vite 內部的網址路徑
  // 行號是轉譯後的程式碼位置，和原始檔對不上，所以只取檔案
  function fileFromStack(stack) {
    for (const match of stack.matchAll(/https?:\/\/[^/\s)]+(\/[^?:\s)]+)(?:\?[^:\s)]*)?:\d+:\d+/g)) {
      const file = decodeURIComponent(match[1]);
      if (file.includes('/node_modules/') || file.startsWith('/@') || file.includes('/__wta/')) continue;
      return file.replace(/^\//, '');
    }
    return null;
  }

  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    return `${el.localName}${id}${cls}`;
  }

  function showToast(message, isError = false) {
    ui.toast.textContent = message;
    ui.toast.classList.toggle('wta-toast-error', isError);
    ui.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      ui.toast.hidden = true;
    }, 2500);
  }

  function connectReload() {
    const source = new EventSource('/__wta/events');
    source.addEventListener('reload', () => location.reload());
  }

  function readActive() {
    try {
      return sessionStorage.getItem(activeKey) === '1';
    } catch {
      return false;
    }
  }

  function writeActive(on) {
    try {
      sessionStorage.setItem(activeKey, on ? '1' : '0');
    } catch {
      // sessionStorage 不可用時忽略，只影響重新整理後是否保留圈選模式
    }
  }

  function readQueue() {
    try {
      const list = JSON.parse(sessionStorage.getItem(queueKey) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // 待送清單存 sessionStorage，CLI 改檔觸發重新整理時不會遺失
  function writeQueue() {
    try {
      sessionStorage.setItem(queueKey, JSON.stringify(state.queue));
    } catch {
      // sessionStorage 不可用時清單只存在記憶體，重新整理會遺失
    }
  }
})();
