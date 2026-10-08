(() => {

  const STYLES = new Set(['default','plain','color','dashed','background','border','quote']);
  const SIZES = new Set([80,100,115,130,150]);
  const LAYERS = ['original','annotation','translation'];
  const FIELDS = ['style','color','size'];

  const frozenLayer = (style,color='auto',size=100) => Object.freeze({style,color,size});
  const defaults = Object.freeze({
    original:frozenLayer('background'),
    annotation:frozenLayer('plain'),
    translation:frozenLayer('default'),
  });
  const palettes = Object.freeze([
    Object.freeze({id:'amber',label:'麦穗金',color:'#b7791f'}),
    Object.freeze({id:'teal',label:'松石绿',color:'#287d70'}),
    Object.freeze({id:'blue',label:'湖蓝',color:'#356cb1'}),
    Object.freeze({id:'violet',label:'雾紫',color:'#7958a5'}),
    Object.freeze({id:'rose',label:'陶土红',color:'#b45c63'}),
  ]);

  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const validColor = value => value === 'auto' || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value));
  const normalizeLayer = (value,fallback) => {
    const source = object(value) ? value : {};
    return {
      style:STYLES.has(source.style) ? source.style : fallback.style,
      color:validColor(source.color) ? source.color.toLowerCase() : fallback.color,
      size:SIZES.has(source.size) ? source.size : fallback.size,
    };
  };

  function normalize(value) {
    const source = object(value) ? value : {};
    const legacy = !Object.hasOwn(source,'original') && !Object.hasOwn(source,'annotation')
          && !object(source.translation) && ['translation','color','size'].some(key => Object.hasOwn(source,key));
    if (legacy) {
      const style = STYLES.has(source.translation) ? source.translation : 'default';
      const color = validColor(source.color) ? source.color.toLowerCase() : 'auto';
      const size = SIZES.has(source.size) ? source.size : 100;
      return {
        original:{style:'background',color,size:100},
        annotation:{style,color:style==='quote'?'auto':color,size},
        translation:{style,color,size},
      };
    }
    return Object.fromEntries(LAYERS.map(layer => [layer,normalizeLayer(source[layer],defaults[layer])]));
  }

  function validate(value) {
    if (!object(value)) throw new Error('无效的阅读样式。');
    const keys = Object.keys(value);
    if (keys.length !== LAYERS.length || keys.some(key => !LAYERS.includes(key)) || LAYERS.some(key => !Object.hasOwn(value,key))) {
      throw new Error('阅读样式必须包含且只能包含三层设置。');
    }
    for (const layer of LAYERS) {
      const setting = value[layer];
      if (!object(setting)) throw new Error('无效的分层阅读样式。');
      const fields = Object.keys(setting);
      if (fields.length !== FIELDS.length || fields.some(field => !FIELDS.includes(field)) || FIELDS.some(field => !Object.hasOwn(setting,field))) {
        throw new Error('分层阅读样式必须包含且只能包含已知设置。');
      }
      if (!STYLES.has(setting.style)) throw new Error('无效的阅读装饰。');
      if (!validColor(setting.color)) throw new Error('阅读样式颜色必须是 auto 或六位十六进制颜色。');
      if (!SIZES.has(setting.size)) throw new Error('无效的阅读字号。');
    }
    return normalize(value);
  }

  function staticSelector(value,name) {
    if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[{},;@\\]/.test(value)) {
      throw new Error(`${name} 必须是静态 CSS 选择器。`);
    }
    return value.trim();
  }

  function customForeground(color) {
    const channels = [1,3,5].map(offset => {
      const component = Number.parseInt(color.slice(offset,offset+2),16) / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.179 ? '#000000' : '#ffffff';
  }

  function decorate(rules,setting,layer) {
    const resolved = setting.style === 'default'
      ? (layer === 'original' ? 'background' : layer === 'translation' ? 'default' : 'plain')
      : setting.style;
    const accent = setting.color === 'auto' ? 'var(--ss-source-color,inherit)' : setting.color;
    const line = setting.color === 'auto' ? 'currentColor' : setting.color;
    const background = setting.color === 'auto' ? 'var(--accent-soft)' : setting.color;
    const foreground = setting.color === 'auto' ? 'var(--ink)' : customForeground(setting.color);
    if (resolved === 'color') rules.push(`color:${accent}`);
    else if (resolved === 'dashed') rules.push(layer === 'translation' ? `border-left:2px dashed ${line}` : `border-bottom:1px dashed ${line}`);
    else if (resolved === 'background') rules.push(`background:${background}`,`color:${foreground}`,'border-radius:3px');
    else if (resolved === 'border') rules.push(`border:1px solid ${line}`,'border-radius:3px');
    else if (resolved === 'quote') rules.push('font-style:italic',layer === 'translation' ? `border-left:2px solid ${line}` : `color:${accent}`);
    return resolved;
  }

  function css(style,selectors) {
    const current = validate(style);
    if (!object(selectors)) throw new Error('缺少阅读样式选择器。');
    if (Object.keys(selectors).some(key => !['mark','hint','block','annotation'].includes(key))) throw new Error('未知的阅读样式选择器。');
    const mark = staticSelector(selectors.mark,'原文标记');
    const hint = staticSelector(selectors.hint,'短提示');
    const annotation = staticSelector(selectors.annotation,'词注容器');
    const block = staticSelector(selectors.block,'双语译文');
    const rules = [];
    const hintScale = current.annotation.size / 100;

    const labelRow = `calc(max(13px,calc(var(--type-support) * ${hintScale})) * 1.45 + 4px)`;
    // Labels reserve vertical space only; the word keeps its natural width so host
    // text rhythm is untouched. Collisions are staggered by layoutHints().
    rules.push(`${annotation}{font:inherit!important;letter-spacing:inherit!important;color:inherit!important;display:inline-block!important;position:relative!important;vertical-align:baseline!important;line-height:1.1!important;margin:0!important;text-align:center!important;max-width:100%!important;border:0!important;background:none!important;padding:${labelRow} 0 0!important}`);
    rules.push(`${annotation}[data-shisui-label-level="2"]{padding:calc((${labelRow}) * 2) 0 0!important}`);

    const markRules = ['font-family:inherit',`font-size:${current.original.size}%`,'line-height:inherit','letter-spacing:inherit','background:none','color:inherit','border:0','border-bottom:0','border-radius:0','box-shadow:none','display:inline','filter:none','font-style:inherit','font-weight:inherit','opacity:1','padding:0','text-decoration:none','text-decoration-color:currentColor','text-decoration-line:none','text-decoration-style:solid','text-decoration-thickness:auto','text-underline-offset:auto'];
    const hintRules = ['background:none','border:0','border-bottom:0','border-radius:0','box-shadow:none','box-sizing:border-box','color:inherit','display:block','position:absolute','left:50%','top:2px','transform:translateX(-50%)','max-width:min(16em,60vw)','filter:none','font-family:var(--ss-source-font,inherit)','font-style:normal',`font-size:max(13px,calc(var(--type-support) * ${hintScale}))`,'font-weight:var(--weight-regular)','line-height:1.45','letter-spacing:.035em','word-spacing:normal','margin:0','opacity:1','padding:0','text-align:center','text-decoration:none','white-space:nowrap','overflow:hidden','text-overflow:ellipsis'];
    const blockRules = ['background:none','border:0','border-left:0','border-radius:0','box-shadow:none','box-sizing:border-box','color:var(--ss-source-color,inherit)','display:block','filter:none','font-family:var(--ss-source-font,inherit)','font-style:normal',`font-size:max(13px,calc(var(--ss-source-size,1em) * ${current.translation.size / 100}))`,'font-weight:var(--weight-regular)','line-height:var(--ss-source-leading,inherit)','margin:.4em 0','opacity:1','padding:0','min-width:0','max-width:100%','text-decoration:none','white-space:pre-wrap','overflow-wrap:anywhere','word-break:normal'];

    const markStyle = decorate(markRules,current.original,'original');
    const hintStyle = decorate(hintRules,current.annotation,'annotation');
    const blockStyle = decorate(blockRules,current.translation,'translation');
    if(['quote','border','background','dashed'].includes(blockStyle))blockRules.push('padding:.55em .75em');
    rules.push(`${mark}{${markRules.map(rule=>rule+'!important').join(';')}}`,`${hint}{${hintRules.map(rule=>rule+'!important').join(';')}}`,`${block}{${blockRules.map(rule=>rule+'!important').join(';')}}`);
    // Host gradient selectors can also match our spans; their transparent fill must not hide owned text.
    rules.push(`${mark},${hint},${block}{-webkit-text-fill-color:currentColor!important}`);
    rules.push(`${mark}::before,${mark}::after{content:none!important}`,`${hint}::before,${hint}::after{content:none!important}`,`${block}::before,${block}::after{content:none!important}`);
    for (const [selector,resolved] of [[mark,markStyle],[hint,hintStyle],[block,blockStyle]]) {
      if (resolved === 'quote' && selector !== block) rules.push(`${selector}::before{content:"“"!important}`,`${selector}::after{content:"”"!important}`);
    }
    return rules.join('\n');
  }

  // Stagger floating labels without ever widening the annotated word. Items are
  // {wrapper, hint} pairs; entries settle in list order, so earlier labels keep
  // the row nearest the text and later colliding labels rise one level. When two
  // levels cannot separate neighbors the later label is clamped to the free gap
  // (full text remains in its title and the lookup card).
  function layoutHints(items) {
    const entries = [];
    for (const item of items || []) {
      const wrapper = item?.wrapper, hint = item?.hint;
      if (!wrapper?.isConnected || !hint?.isConnected) continue;
      const view = wrapper.ownerDocument?.defaultView;
      if (!view) continue;
      delete wrapper.dataset.shisuiLabelLevel;
      hint.style.removeProperty('max-width');
      hint.style.setProperty('max-width','none','important');
      const natural = hint.getBoundingClientRect().width;
      hint.style.removeProperty('max-width');
      const rect = wrapper.getBoundingClientRect();
      const fontSize = parseFloat(view.getComputedStyle(hint).fontSize) || 13;
      if (!(natural > 0) || !(rect.width > 0)) continue;
      const rowUnit = parseFloat(view.getComputedStyle(wrapper).paddingTop) || Math.ceil(fontSize * 1.45) + 1;
      entries.push({ wrapper, hint, natural, rect, fontSize, rowUnit, view, width: Math.min(natural, fontSize * 16, view.innerWidth * 0.6), level: 1, shift: 0, box: null });
    }
    const band = entry => {
      const center = entry.rect.left + entry.rect.width / 2 + entry.shift;
      const top = entry.rect.top + 2 - (entry.level - 1) * entry.rowUnit;
      return { left: center - entry.width / 2, right: center + entry.width / 2, top, bottom: top + entry.rowUnit - 4 };
    };
    const overlap = (a, b) => a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2;
    // Fit each label inside the largest free span of its row: viewport edges and
    // already-settled labels both bound the span. Prefer full width with a small
    // horizontal shift; truncate only when the span itself is too narrow.
    const fitRow = (entry, peers) => {
      const center = entry.rect.left + entry.rect.width / 2;
      let left = 8, right = entry.view.innerWidth - 8;
      for (const other of peers) {
        if (other.box.top >= entry.box.bottom - 2 || other.box.bottom <= entry.box.top + 2) continue;
        if (other.box.right <= center) left = Math.max(left, other.box.right + 6);
        else if (other.box.left >= center) right = Math.min(right, other.box.left - 6);
        else if (right - (other.box.right + 6) >= other.box.left - 6 - left) left = Math.max(left, other.box.right + 6);
        else right = Math.min(right, other.box.left - 6);
      }
      if (right - left < entry.fontSize * 2) return;
      entry.width = Math.max(entry.fontSize * 2, Math.min(entry.width, right - left));
      entry.shift = Math.min(Math.max(center, left + entry.width / 2), right - entry.width / 2) - center;
      entry.box = band(entry);
    };
    const settled = [];
    for (const entry of entries) {
      const peers = settled.filter(other => Math.abs(other.rect.top - entry.rect.top) <= entry.rowUnit);
      for (let level = 1; level <= 2; level++) {
        entry.level = level;
        entry.shift = 0;
        entry.box = band(entry);
        if (!peers.some(other => overlap(entry.box, other.box))) break;
      }
      fitRow(entry, peers);
      settled.push(entry);
    }
    for (const entry of entries) {
      if (entry.level > 1) entry.wrapper.dataset.shisuiLabelLevel = String(entry.level);
      else delete entry.wrapper.dataset.shisuiLabelLevel;
      if (entry.width + 1 < entry.natural) entry.hint.style.setProperty('max-width', entry.width + 'px', 'important');
      else entry.hint.style.removeProperty('max-width');
      if (Math.abs(entry.shift) >= 1) entry.hint.style.setProperty('left', 'calc(50% + ' + Math.round(entry.shift) + 'px)', 'important');
      else entry.hint.style.removeProperty('left');
    }
  }

  globalThis.ShisuiReadingStyle = Object.freeze({defaults,palettes,normalize,validate,css,layoutHints});
})();