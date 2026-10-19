/**
 * ZS Live 父页面桥接 SDK（供业务前端 iframe 接入）
 * 调用方式与平行云 gameAPI 一致：stream.camera('config', params)
 *
 * 用法：
 *   <script src="http://<server>:<port>/sdk/zslive-parent.js"></script>
 *   const stream = ZsLive.mount({ container: '#app', baseUrl: 'http://<server>:<port>', template: '1', streamId: 'view-a' });
 *   stream.on('inputready', () => stream.camera('config', { fov: 90 }));
 *
 * 事件：ready / assigned / streaming / inputready / platform / error / ue / disconnected
 * 键盘：鼠标悬停推流区时，SDK 自动把父页按键 postMessage 进嵌入页（forwardKeys 默认开启）
 */
;(function (global) {
  const MSG_SOURCE_PARENT = 'zslive-parent';
  const MSG_SOURCE_EMBED = 'zslive-embed';

  function resolveEl(container) {
    if (!container) return null;
    if (typeof container === 'string') return document.querySelector(container);
    return container;
  }

  function generateStreamId() {
    return 'view_' + Math.random().toString(36).slice(2, 10);
  }

  function resolveStreamId(streamId) {
    const id = streamId != null ? String(streamId).trim() : '';
    return id || generateStreamId();
  }

  function buildEmbedSrc(baseUrl, template, streamId) {
    const base = (baseUrl || '').replace(/\/+$/, '');
    const origin = base || (typeof location !== 'undefined' ? location.origin : '');
    const q = new URLSearchParams({ template: template || '', autoconnect: '1' });
    if (streamId) q.set('streamId', streamId);
    return origin + '/embed?' + q.toString();
  }

  function postToEmbed(iframe, streamId, payload) {
    if (!iframe || !iframe.contentWindow) return { ok: false, error: 'iframe 未就绪' };
    iframe.contentWindow.postMessage({ source: MSG_SOURCE_PARENT, streamId, ...payload }, '*');
    return { ok: true };
  }

  function parentTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function shouldCaptureKey(code) {
    if (!code) return false;
    return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)
      || /^Arrow(Up|Down|Left|Right)$/.test(code) || code === 'Space'
      || /^Shift(Left|Right)$/.test(code) || /^Control(Left|Right)$/.test(code) || /^Alt(Left|Right)$/.test(code);
  }

  class ZsLiveStream {
    constructor({ streamId, template, container, baseUrl, iframeAttrs, forwardKeys } = {}) {
      this.streamId = resolveStreamId(streamId);
      this.template = template || '';
      this.baseUrl = baseUrl;
      this.container = resolveEl(container);
      this.iframeAttrs = iframeAttrs || {};
      this.forwardKeys = forwardKeys !== false;
      this.iframe = null;
      this._handlers = new Map();
      this._ready = false;
      this._inputReady = false;
      this._pointerOver = false;
      this._pressedCodes = new Set();
      this._lastErrorData = null;
      this._lastErrorAt = 0;
      this._onMessage = this._onMessage.bind(this);
      this._onKeyDown = (e) => this._forwardKey('down', e);
      this._onKeyUp = (e) => this._forwardKey('up', e);
      this._onContainerPointerDown = () => this.focus();
      global.addEventListener('message', this._onMessage);
      if (this.forwardKeys) {
        global.addEventListener('keydown', this._onKeyDown, true);
        global.addEventListener('keyup', this._onKeyUp, true);
      }
      this._mountIframe();
    }

    _mountIframe() {
      if (!this.container) throw new Error('ZsLive: container 未找到');
      const iframe = document.createElement('iframe');
      iframe.src = buildEmbedSrc(this.baseUrl, this.template, this.streamId);
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
      iframe.setAttribute('tabindex', '0');
      iframe.title = 'ZS Live ' + this.streamId;
      Object.assign(iframe, this.iframeAttrs);
      this.container.innerHTML = '';
      this.container.appendChild(iframe);
      this.iframe = iframe;
      this.container.addEventListener('pointerdown', this._onContainerPointerDown);
    }

    _isFromMyIframe(ev) {
      try { return !!(this.iframe && this.iframe.contentWindow && ev.source === this.iframe.contentWindow); }
      catch { return false; }
    }

    _onMessage(ev) {
      const msg = ev.data;
      if (!msg || msg.source !== MSG_SOURCE_EMBED) return;
      const fromMine = this._isFromMyIframe(ev);
      if (!fromMine) {
        if (msg.streamId && msg.streamId !== this.streamId) return;
        if (!msg.streamId) return; // 多路时无 streamId 不可收，避免串台
      }
      if (msg.type !== 'event') return;

      const event = msg.event;
      if (event === 'ready') this._ready = true;
      if (event === 'inputready') { this._inputReady = true; this.focus(); }
      if (event === 'streaming') this.focus();
      if (event === 'pointerover') this._pointerOver = true;
      if (event === 'pointerout') { this._pointerOver = false; this._releaseForwardedKeys(); }
      this._emit(event, msg.data);
      if (event === 'platform' && msg.data && msg.data.level === 'error') this._emitError(msg.data);
      if (event === 'error') { this._lastErrorData = msg.data || null; this._lastErrorAt = Date.now(); }
    }

    _emit(event, data) {
      const set = this._handlers.get(event);
      if (!set) return;
      for (const fn of set) { try { fn(data); } catch (e) { console.error('[ZsLive]', e); } }
    }

    _emitError(data) {
      this._lastErrorData = data || null;
      this._lastErrorAt = Date.now();
      this._emit('error', data);
    }

    _canForwardKeys(e) {
      return this.forwardKeys && this._pointerOver && this._inputReady && !parentTypingTarget(e && e.target);
    }

    _forwardKey(phase, e) {
      if (!this._canForwardKeys(e)) return false;
      postToEmbed(this.iframe, this.streamId, {
        type: 'keyboard', phase,
        code: e.code, key: e.key, keyCode: e.keyCode, charCode: e.charCode, repeat: !!e.repeat,
      });
      if (phase === 'down') this._pressedCodes.add(e.code);
      if (phase === 'up') this._pressedCodes.delete(e.code);
      if (shouldCaptureKey(e.code)) { e.preventDefault(); e.stopPropagation(); }
      return true;
    }

    _releaseForwardedKeys() {
      if (!this._pressedCodes.size) return;
      for (const code of [...this._pressedCodes]) {
        postToEmbed(this.iframe, this.streamId, { type: 'keyboard', phase: 'up', code, key: code });
      }
      this._pressedCodes.clear();
    }

    on(event, fn) {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event).add(fn);
      // 晚注册时补发最近一次错误
      if ((event === 'error' || event === 'platform') && this._lastErrorData && Date.now() - this._lastErrorAt < 30000) {
        try { fn(this._lastErrorData); } catch (e) { console.error('[ZsLive]', e); }
      }
      return () => this.off(event, fn);
    }

    off(event, fn) {
      const set = this._handlers.get(event);
      if (set) set.delete(fn);
    }

    _send(type, payload) {
      return postToEmbed(this.iframe, this.streamId, { type, ...payload });
    }

    /** 让推流 iframe 获得浏览器焦点 */
    focus() {
      try { if (this.iframe && this.iframe.focus) this.iframe.focus(); } catch { /* ignore */ }
      return this._send('focus', {});
    }

    /** 通用调用：stream.invoke('camera', 'config', {...}) -> UE 指令 camera.config */
    invoke(module, action, params) {
      return this._send('invoke', { module, action, params: params == null ? {} : params });
    }

    camera(action, params) {
      return this._send('camera', { action, params: params == null ? {} : params });
    }

    /** 自定义指令 -> UE 指令 <name> */
    sendCommand(name, payload) {
      return this._send('command', { name, payload: payload == null ? {} : payload });
    }

    /** 原始 JSON 字符串指令（自动解析 module.action / name 形态） */
    sendRaw(descriptor) {
      return this._send('sendRaw', { descriptor: String(descriptor) });
    }

    disconnect() {
      return this._send('disconnect', {});
    }

    destroy() {
      this._releaseForwardedKeys();
      global.removeEventListener('message', this._onMessage);
      if (this.forwardKeys) {
        global.removeEventListener('keydown', this._onKeyDown, true);
        global.removeEventListener('keyup', this._onKeyUp, true);
      }
      if (this.container) this.container.removeEventListener('pointerdown', this._onContainerPointerDown);
      this.disconnect();
      if (this.iframe && this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;
      this._handlers.clear();
    }

    get isReady() { return this._ready; }
    get isInputReady() { return this._inputReady; }
  }

  /** 多路管理：同页多路推流时按 streamId 路由 */
  class ZsLiveHub {
    constructor() { this._streams = new Map(); }
    mount(options) {
      const stream = new ZsLiveStream(options);
      const id = stream.streamId;
      if (this._streams.has(id)) this._streams.get(id).destroy();
      this._streams.set(id, stream);
      return stream;
    }
    get(streamId) { return this._streams.get(streamId) || null; }
    has(streamId) { return this._streams.has(streamId); }
    destroy(streamId) {
      const s = this._streams.get(streamId);
      if (s) { s.destroy(); this._streams.delete(streamId); }
    }
    destroyAll() { for (const id of [...this._streams.keys()]) this.destroy(id); }
    list() { return [...this._streams.keys()]; }
  }

  global.ZsLive = {
    mount: (options) => new ZsLiveStream(options),
    Hub: ZsLiveHub,
    buildEmbedSrc,
    generateStreamId,
    MSG_SOURCE_PARENT,
    MSG_SOURCE_EMBED,
  };
  global.ZsLiveHub = ZsLiveHub;
})(typeof window !== 'undefined' ? window : globalThis);
