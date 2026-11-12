// 快捷键共用件：拦截提示、空格拦截与播放速率档位格式化。
// ESM init 模块：initMaweShortcuts 在原清单位次执行原 IIFE 体（挂
// window.MaweShortcuts 冻结门面——classic 侧出接口）；底部具名导出经门面
// 在调用时转发，兄弟模块可静态 import。
export function initMaweShortcuts() {
(function initMaweShortcuts(global) {
  'use strict';



  function showShortcutBlocked(message) {
    MaweHint.flashHint(message, 'invalid');
  }



  // 空格播放/暂停。捕获阶段先于原生媒体控件处理，避免控件获得焦点后执行默认行为。
  let interceptedSpace = false;
  let interceptedSpaceCode = null;



  // J/K/L 播放控制的两种模式：旧模式是慢速/重置/倍速；新模式是倒放/停止/1×播放。
  // HTML5 playbackRate 多数浏览器钳在 [0.0625, 16]，反向播放由时间轴驱动。
  const PLAYBACK_RATE_MIN = 0.0625;


  const PLAYBACK_RATE_MAX = 16;


  function fmtRate(r) {
    // 保留必要小数位：0.5/2/4 不带小数；0.25/0.0625 带
    if (Number.isInteger(r)) return r + '×';
    // 去掉尾部 0
    return r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '×';
  }


  // Bindings describe the existing command vocabulary. resolveEvent projects a
  // physical chord onto it, so domain handlers retain their selection/focus guards
  // and operate on the original event (no synthetic keyboard dispatch).
  const BINDINGS_KEY = 'moy.asr.editor.shortcuts.v1';
  const commands = [];
  function command(id, label, ...defaults) {
    commands.push(Object.freeze({ id, label, defaults: Object.freeze(defaults) }));
  }
  command('play', '播放 / 暂停', 'Space');
  command('reverse', '倒放 / 降低速度', 'j');
  command('stop', '停止 / 重置速度', 'k');
  command('forward', '正放 / 提高速度', 'l');
  for (const [key, label] of [['a', '上一条字幕（横向）'], ['d', '下一条字幕（横向）'], ['w', '上一条字幕（纵向）'], ['s', '下一条字幕（纵向）']]) {
    command('nav-' + key, label, key);
    command('extend-' + key, '追加选择：' + label, 'Shift+' + key);
  }
  for (const [key, label] of [['ArrowLeft', '向前'], ['ArrowRight', '向后']]) {
    command('seek-' + key, label + '跳转 / 移动字幕', key);
    command('snap-' + key, label + '贴合边界', 'Shift+' + key);
    command('start-' + key, label + '微调起点', 'Mod+' + key);
    command('end-' + key, label + '微调终点', 'Mod+Shift+' + key);
    command('independent-' + key, label + '移动（反转联动）', 'Alt+' + key);
    command('independent-start-' + key, label + '微调起点（反转联动）', 'Mod+Alt+' + key);
    command('independent-end-' + key, label + '微调终点（反转联动）', 'Mod+Alt+Shift+' + key);
  }
  command('track-up', '切换到上方字幕轨', 'ArrowUp');
  command('track-down', '切换到下方字幕轨', 'ArrowDown');
  command('home', '跳转到开头', 'Home');
  command('end', '跳转到结尾', 'End');
  command('select-all', '选中所有字幕', 'Mod+a');
  command('deselect', '取消选择', 'Mod+d');
  command('merge-prev', '合并前一条字幕', 'Mod+Shift+a');
  command('merge-next', '合并后一条字幕', 'Mod+Shift+d');
  command('split', '拆分字幕', 'b');
  command('merge', '合并选中字幕', 'c');
  command('edit', '激活字幕编辑区', 'Enter');
  command('preview', '跳转并播放选中字幕', 'f');
  command('cue-start', '跳到字幕起点', 'i');
  command('cue-end', '跳到字幕终点', 'o');
  command('trim-start', '起点定位到时间基准', 'z');
  command('trim-end', '终点定位到时间基准', 'x');
  command('add', '创建字幕', 'n');
  command('bind', '绑定主副字幕', 'g');
  command('unbind', '解绑副字幕', 'Shift+g');
  command('align', '对齐副字幕时间', 'h');
  command('sticker', '分配表情包', 't');
  command('select-tool', '选择工具', 'v');
  command('razor-tool', '分割工具', 'r');
  command('delete', '删除选中字幕', 'Delete', 'Backspace');
  command('undo', '撤销', 'Mod+z');
  command('redo', '重做', 'Mod+Shift+z', 'Mod+y');
  command('save', '保存工程', 'Mod+s');
  command('save-as', '工程另存为', 'Mod+Shift+s');
  // These legacy handlers are contextual and remain outside the customizable
  // command list. Reserve their physical chords so remapping cannot double-fire.
  const fixedBindings = [
    { chord: 'm', owner: null, label: '固定快捷键 M（切换标记编辑）' },
    { chord: 'q', owner: null, label: '固定快捷键 Q（切换字词时间码）' },
    { chord: 'c', owner: 'merge', label: '固定快捷键 C（字词选区合并）' },
    { chord: 'Shift+c', owner: 'merge', label: '固定快捷键 Shift+C（字词选区合并）' },
    { chord: 'f', owner: 'preview', label: '固定快捷键 F（字词选区试听）' },
  ];
  // 2.0dev supports five or nine active colour slots; all nine remain
  // remappable, while inactive slots safely no-op in the domain handler.
  for (let i = 0; i <= 9; i++) command('color-' + i, i ? '分配颜色 ' + i : '清除颜色', String(i));
  Object.freeze(commands);

  function chord(event) {
    let key = event.key;
    if (key === ' ' || key === 'Spacebar') key = 'Space';
    if (/^Digit[0-9]$/.test(event.code || '')) key = event.code.slice(5);
    else if ((event.altKey || key?.length === 1 && !/^[a-z]$/i.test(key)) && /^Key[A-Z]$/.test(event.code || '')) key = event.code.slice(3);
    if (key?.length === 1) key = key.toLowerCase();
    if (!key || ['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(key)) return null;
    return [event.ctrlKey || event.metaKey ? 'Mod' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+');
  }

  function validChord(value) {
    if (typeof value !== 'string') return false;
    return /^(Mod\+)?(Alt\+)?(Shift\+)?([a-z0-9]|Space|Enter|Delete|Backspace|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|F[1-9]|F1[0-2])$/.test(value)
      && !/^(Mod\+)(Alt\+)?(Shift\+)?(h|l|t|w|r|n|p|q|F[1-9]|F1[0-2])$/.test(value)
      && value !== 'Mod+c'
      && !/^Alt\+(Shift\+)?(Home|F4)$/.test(value)
      && value !== 'F5' && value !== 'F11' && value !== 'F12';
  }

  function addModifiers(value, additions) {
    const parts = value.split('+');
    const key = parts.pop();
    const modifiers = new Set([...parts, ...additions]);
    return ['Mod', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier)).concat(key).join('+');
  }

  function reservedReason(value) {
    if (value === 'Mod+c') return '系统复制快捷键必须保留';
    if (/^Mod\+(?:Alt\+)?Shift\+q$/.test(value)) {
      return 'macOS：Cmd+Shift+Q 会注销用户；Windows/Linux Chromium：Ctrl+Shift+Q 用于退出确认；ChromeOS：Ctrl+Shift+Q 两次会注销会话';
    }
    if (value === 'Mod+h') {
      return 'macOS：Cmd+H 会隐藏当前应用；Windows/Linux Chromium：Ctrl+H 会打开浏览器历史记录';
    }
    return '此组合由浏览器或操作系统保留';
  }

  function reservedChordError(value, isSplitVariant = false) {
    const prefix = isSplitVariant
      ? '快捷键派生组合与系统或浏览器保留功能冲突：'
      : '快捷键组合与系统或浏览器保留功能冲突：';
    return new Error(prefix + displayChord(value) + '；' + reservedReason(value));
  }

  let overrides = {};
  const savedBindingWarnings = [];
  function bindings(entry, source = overrides) { return source[entry.id] || entry.defaults; }
  function effectiveBindings(entry, source = overrides) {
    const active = bindings(entry, source);
    if (entry.id !== 'split') {
      const preserveAltSemantics = /^(?:nav|extend)-[adws]$/.test(entry.id);
      const result = [];
      const mapped = new Map();
      for (const value of active) {
        const target = entry.defaults.includes(value) ? value : entry.defaults[0];
        const variants = [[value, target]];
        if (preserveAltSemantics) variants.push([
          addModifiers(value, ['Alt']),
          addModifiers(target, ['Alt']),
        ]);
        for (const [chordValue, targetValue] of variants) {
          if (mapped.has(chordValue)) {
            if (mapped.get(chordValue) !== targetValue) {
              throw new Error('键盘快捷键的 Alt 派生组合冲突，无法保留原修饰键语义：' + displayChord(chordValue));
            }
            continue;
          }
          mapped.set(chordValue, targetValue);
          result.push({ chord: chordValue, target: targetValue });
        }
      }
      return result;
    }
    const result = [];
    const mapped = new Map();
    for (const value of active) {
      const variants = [
        [value, 'b'],
        [addModifiers(value, ['Shift']), 'Shift+b'],
        [addModifiers(value, ['Mod', 'Shift']), 'Mod+Shift+b'],
      ];
      for (const [chordValue, target] of variants) {
        if (!validChord(chordValue)) throw reservedChordError(chordValue, true);
        if (mapped.has(chordValue)) {
          if (mapped.get(chordValue).target !== target) {
            throw new Error('拆分快捷键派生组合发生冲突，无法区分三种拆分操作：' + displayChord(chordValue));
          }
          continue;
        }
        mapped.set(chordValue, { target });
        result.push({ chord: chordValue, target });
      }
    }
    return result;
  }
  function defaultPhysicalBindings(entry) {
    if (/^(?:nav|extend)-[adws]$/.test(entry.id)) {
      return [...new Set(entry.defaults.flatMap(value => [value, addModifiers(value, ['Alt'])]))];
    }
    if (entry.id !== 'split') return entry.defaults;
    return ['b', 'Shift+b', 'Mod+Shift+b'];
  }
  function suppressesOldChord(entry, physical) {
    const defaults = defaultPhysicalBindings(entry);
    if (/^(?:nav|extend)-[adws]$/.test(entry.id)) return defaults.includes(physical);
    return defaults.includes(physical)
      || defaults.includes(physical.replace(/(?:Alt|Shift)\+/g, ''));
  }
  function isOverriddenSaveChord(physical) {
    if (!physical) return false;
    return commands.some(entry => ['save', 'save-as'].includes(entry.id)
      && defaultPhysicalBindings(entry).includes(physical)
      && !effectiveBindings(entry).some(binding => binding.chord === physical));
  }
  function validate(source, changedId = null) {
    const used = new Map();
    for (const entry of commands) {
      for (const { chord: value } of effectiveBindings(entry, source)) {
        if (!validChord(value)) throw reservedChordError(value);
        const fixed = fixedBindings.find(binding => binding.chord === value && binding.owner !== entry.id);
        if (fixed) {
          const error = new Error('快捷键冲突：' + fixed.label);
          error.shortcutConflict = { previousId: fixed.owner, currentId: entry.id, chord: value,
            labels: { [entry.id]: fixed.label } };
          throw error;
        }
        if (used.has(value) && used.get(value).id !== entry.id) {
          const previous = used.get(value);
          const error = new Error('快捷键冲突：' + (previous.id === changedId ? entry.label : previous.label));
          error.shortcutConflict = { previousId: previous.id, currentId: entry.id, chord: value,
            labels: { [previous.id]: entry.label, [entry.id]: previous.label } };
          throw error;
        }
        used.set(value, entry);
      }
    }
  }
  function describeSavedBindingWarning(entry, value, error) {
    const messageText = error?.message || '保存格式无效';
    const conflictPrefix = '快捷键冲突：';
    if (messageText.startsWith(conflictPrefix)) {
      return { label: entry.label, chord: Array.isArray(value) ? value.join(', ') : String(value),
        reason: conflictPrefix, detail: messageText.slice(conflictPrefix.length) };
    }
    const prefixes = [
      '快捷键派生组合与系统或浏览器保留功能冲突：',
      '快捷键组合与系统或浏览器保留功能冲突：',
    ];
    const prefix = prefixes.find(item => messageText.startsWith(item));
    if (prefix) {
      const detail = messageText.slice(prefix.length).split('；');
      return { label: entry.label, chord: detail[0], reason: detail.slice(1).join('；') };
    }
    return { label: entry.label, chord: Array.isArray(value) ? value.join(', ') : String(value), reason: messageText };
  }
  try {
    const saved = JSON.parse(MaweHost.storage.getItem(BINDINGS_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const candidate = {};
      for (const entry of commands) {
        if (Object.hasOwn(saved, entry.id)) {
          const value = saved[entry.id];
          try {
            if (!Array.isArray(value) || value.length > 2) throw new Error('保存格式无效');
            const isolated = { [entry.id]: value };
            for (const binding of effectiveBindings(entry, isolated)) {
              if (!validChord(binding.chord)) throw reservedChordError(binding.chord, entry.id === 'split');
            }
            Object.assign(candidate, { [entry.id]: value });
          } catch (error) {
            savedBindingWarnings.push(describeSavedBindingWarning(entry, value, error));
          }
        }
      }
      // Validate the complete migrated set first. Otherwise an early saved
      // override can be rejected against a default chord that a later override
      // legally moves away from (for example play=J, reverse=P).
      while (true) {
        try {
          validate(candidate);
          break;
        } catch (error) {
          const conflict = error.shortcutConflict;
          const overridden = conflict
            ? [conflict.previousId, conflict.currentId].filter(id => id && Object.hasOwn(candidate, id))
            : [];
          if (!overridden.length) break;
          // Keep the earliest valid saved command when two saved overrides
          // collide; if only one side is overridden, defaults win over it.
          const dropId = overridden.includes(conflict.currentId) ? conflict.currentId : overridden[0];
          const droppedEntry = commands.find(item => item.id === dropId);
          const warningError = conflict.labels?.[dropId]
            ? new Error('快捷键冲突：' + conflict.labels[dropId]) : error;
          savedBindingWarnings.push(describeSavedBindingWarning(droppedEntry, saved[dropId], warningError));
          delete candidate[dropId];
        }
      }
      overrides = candidate;
    }
  } catch (_) { /* Unavailable storage or invalid saved data: use defaults. */ }

  function setBinding(id, value) {
    if (!commands.some(entry => entry.id === id)) throw new Error('Unknown shortcut');
    const next = { ...overrides };
    if (value === null) delete next[id];
    else next[id] = value === '' ? [] : [value];
    validate(next, id);
    // A denied write must leave the live binding unchanged, too.
    MaweHost.storage.setItem(BINDINGS_KEY, JSON.stringify(next));
    overrides = next;
  }
  function resetBindings() {
    MaweHost.storage.setItem(BINDINGS_KEY, '{}');
    overrides = {};
  }
  function takeSavedBindingWarnings() { return savedBindingWarnings.splice(0); }
  function displayChord(value) {
    return value.split('+').map(part => part === 'Mod'
      ? (/Mac|iPhone|iPad/.test(global.navigator?.platform || '') ? 'Cmd' : 'Ctrl')
      : part.length === 1 ? part.toUpperCase() : part).join('+');
  }
  function splitVariantLabel(target) {
    const entry = commands.find(item => item.id === 'split');
    const binding = effectiveBindings(entry).find(item => item.target === target);
    return binding ? displayChord(binding.chord) : '';
  }
  const resolvedEvents = new WeakMap();
  const projectedEvents = new WeakMap();
  function projectedEvent(event, value) {
    const parts = value.split('+');
    const key = parts.pop();
    const fields = { key: key === 'Space' ? ' ' : key, code: key === 'Space' ? 'Space' : '',
      ctrlKey: parts.includes('Mod') && !event.metaKey, metaKey: parts.includes('Mod') && Boolean(event.metaKey),
      altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') };
    const projected = new Proxy(event, { get(target, name) {
      if (Object.hasOwn(fields, name)) return fields[name];
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    projectedEvents.set(projected, event);
    return projected;
  }
  function physicalCode(event) { return projectedEvents.get(event)?.code || event?.code || event?.key || null; }
  function resolveEvent(event) {
    if (resolvedEvents.has(event)) return resolvedEvents.get(event);
    let result = event;
    const physical = chord(event);
    const textEditing = MaweKeyboardTargets.isTextEditingTarget(event);
    const modal = document.querySelector('.modal-mask.show, #ctxmenu.show');
    if (event.isComposing || event.keyCode === 229) result = projectedEvent(event, 'Unidentified');
    else if (!modal && physical) {
      const match = commands.flatMap(item => effectiveBindings(item).map(binding => ({ item, ...binding })))
        .find(binding => binding.chord === physical);
      const entry = match?.item;
      // Native text editing keeps its own shortcuts; project saving is global.
      if (!textEditing || (event.ctrlKey || event.metaKey) && (entry?.id === 'save' || entry?.id === 'save-as'
          || commands.some(item => ['save', 'save-as'].includes(item.id) && item.defaults.includes(physical)))) {
        if (entry) result = projectedEvent(event, match.target);
        else if (commands.some(item => Object.hasOwn(overrides, item.id)
          && suppressesOldChord(item, physical))) {
          result = projectedEvent(event, 'Unidentified');
        }
      }
    }
    resolvedEvents.set(event, result);
    return result;
  }

  global.MaweShortcuts = Object.freeze({
    commands, chord, validChord, bindings, setBinding, resetBindings, takeSavedBindingWarnings, displayChord, resolveEvent,
    effectiveBindings, splitVariantLabel, physicalCode, isOverriddenSaveChord,
    showShortcutBlocked,
    get interceptedSpace() { return interceptedSpace; },
    set interceptedSpace(v) { interceptedSpace = v; },
    get interceptedSpaceCode() { return interceptedSpaceCode; },
    set interceptedSpaceCode(v) { interceptedSpaceCode = v; },
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    fmtRate
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function showShortcutBlocked(...args) { return window.MaweShortcuts.showShortcutBlocked(...args); }
export function PLAYBACK_RATE_MIN(...args) { return window.MaweShortcuts.PLAYBACK_RATE_MIN(...args); }
export function PLAYBACK_RATE_MAX(...args) { return window.MaweShortcuts.PLAYBACK_RATE_MAX(...args); }
export function fmtRate(...args) { return window.MaweShortcuts.fmtRate(...args); }
