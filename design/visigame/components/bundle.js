/* @ds-bundle: {"format":4,"namespace":"Visigame","components":[{"name":"Button"},{"name":"Icon"},{"name":"Meta"},{"name":"Tally"},{"name":"Viewfinder"},{"name":"WorldCard"},{"name":"Segmented"},{"name":"Tabs"},{"name":"Field"},{"name":"Node"},{"name":"Meter"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  var ICONS = {"theme":"<path d=\"m12 2 9 10-9 10L3 12Z\"/><path d=\"m12 7 5 5-5 5-5-5Z\"/>","mountain":"<path d=\"m2 20 7-15 5 9 3-5 5 11Z\"/><path d=\"m6 12 3 2 2-3\"/>","enemy":"<path d=\"M5 16v-5a7 7 0 0 1 14 0v5l-4 2v3H9v-3Z\"/><path d=\"M8 11h2m4 0h2m-6 5h4\"/>","target":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/>","cube":"<path d=\"m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M3 7l9 5v10\"/>","crosshair":"<circle cx=\"12\" cy=\"12\" r=\"6\"/><path d=\"M12 2v5m0 10v5M2 12h5m10 0h5\"/>","settings":"<path d=\"m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>","folder":"<path d=\"M3 6h7l2 2h9v12H3Z\"/><path d=\"M5 3h6l2 2h6\"/>","download":"<path d=\"M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4\"/>","undo":"<path d=\"m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12\"/>","redo":"<path d=\"m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12\"/>","bolt":"<path d=\"m14 2-9 12h6l-1 8 9-12h-6Z\"/>","arrow":"<path d=\"M3 12h18m-6-6 6 6-6 6\"/>","expand":"<path d=\"M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6\"/>","play":"<path d=\"m7 3 14 9-14 9Z\"/>","pause":"<path d=\"M8 4v16m8-16v16\"/>","close":"<path d=\"m5 5 14 14M5 19 19 5\"/>"};

  function cx() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
    return out.join(' ');
  }
  function omit(props, keys) {
    var out = {};
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k) && keys.indexOf(k) < 0) out[k] = props[k];
    return out;
  }
  function useControlled(value, fallback, onChange) {
    var state = React.useState(fallback);
    var controlled = value !== undefined;
    return [controlled ? value : state[0], function (next) {
      if (!controlled) state[1](next);
      if (onChange) onChange(next);
    }];
  }

  function Icon(p) {
    var size = p.size || 20;
    return h('svg', {
      className: cx('vg-icon', p.className), width: size, height: size, viewBox: '0 0 24 24',
      role: p.title ? 'img' : undefined, 'aria-hidden': p.title ? undefined : true, 'aria-label': p.title,
      dangerouslySetInnerHTML: { __html: ICONS[p.name] || '' }
    });
  }

  function iconNode(icon) {
    return typeof icon === 'string' ? h(Icon, { name: icon, size: 18 }) : icon;
  }

  function Button(p) {
    var variant = p.variant || 'secondary';
    var size = p.size || 'md';
    var iconOnly = p.icon && (p.children === undefined || p.children === null);
    var rest = omit(p, ['variant', 'size', 'icon', 'iconEnd', 'shortcut', 'children', 'className']);
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('vg-btn', 'vg-btn--' + variant, 'vg-btn--' + size, iconOnly && 'vg-btn--icon', p.className)
    }),
      p.icon ? h('span', { className: 'vg-btn__icon' }, iconNode(p.icon)) : null,
      iconOnly ? null : h('span', { className: 'vg-btn__label' }, p.children),
      p.iconEnd ? h('span', { className: 'vg-btn__icon' }, iconNode(p.iconEnd)) : null,
      p.shortcut ? h('kbd', { className: 'vg-btn__kbd' }, p.shortcut) : null
    );
  }

  function Meta(p) {
    var items = p.items || [];
    return h(p.as || 'p', { className: cx('vg-meta', p.tone && 'vg-meta--' + p.tone, p.className) },
      items.map(function (item, i) {
        return h(React.Fragment, { key: i },
          i ? h('span', { className: 'vg-meta__sep', 'aria-hidden': true }) : null,
          h('span', { className: 'vg-meta__item' }, item));
      }));
  }

  var TALLY_WORD = { live: 'Live', ready: 'Ready', idle: 'Idle', warn: 'Check' };
  function Tally(p) {
    var state = p.state || 'idle';
    return h('span', { className: cx('vg-tally', 'vg-tally--' + state, p.className), role: 'status' },
      h('i', { className: 'vg-tally__dot', 'aria-hidden': true }),
      h('span', { className: 'vg-tally__label' }, p.children || TALLY_WORD[state]));
  }

  function Viewfinder(p) {
    var rest = omit(p, ['active', 'tone', 'children', 'className', 'as']);
    return h(p.as || 'div', Object.assign({}, rest, {
      className: cx('vg-vf', p.active && 'is-active', 'vg-vf--' + (p.tone || 'peaking'), p.className)
    }),
      p.children,
      h('span', { className: 'vg-vf__c vg-vf__c--tl', 'aria-hidden': true }),
      h('span', { className: 'vg-vf__c vg-vf__c--tr', 'aria-hidden': true }),
      h('span', { className: 'vg-vf__c vg-vf__c--bl', 'aria-hidden': true }),
      h('span', { className: 'vg-vf__c vg-vf__c--br', 'aria-hidden': true }));
  }

  function WorldCard(p) {
    var art = typeof p.art === 'string'
      ? h('span', { className: 'vg-world__img', style: { backgroundImage: 'url("' + p.art + '")' } })
      : p.art;
    return h(Viewfinder, {
      as: 'button', type: 'button', active: p.selected, 'aria-pressed': !!p.selected,
      className: cx('vg-world', p.selected && 'is-selected', p.className), onClick: p.onSelect
    },
      h('span', { className: 'vg-world__art' }, art,
        p.status ? h('span', { className: 'vg-world__status' }, p.status) : null),
      h('span', { className: 'vg-world__body' },
        p.meta ? h(Meta, { as: 'span', items: p.meta }) : null,
        h('span', { className: 'vg-world__title' }, p.title),
        p.children ? h('span', { className: 'vg-world__desc' }, p.children) : null));
  }

  function Segmented(p) {
    var opts = p.options || [];
    var pair = useControlled(p.value, p.defaultValue !== undefined ? p.defaultValue : (opts[0] && opts[0].value), p.onChange);
    return h('div', { className: cx('vg-seg', p.className), role: 'radiogroup', 'aria-label': p.label },
      p.label ? h('span', { className: 'vg-seg__label', 'aria-hidden': true }, p.label) : null,
      opts.map(function (o) {
        var on = o.value === pair[0];
        return h('button', {
          key: o.value, type: 'button', role: 'radio', 'aria-checked': on,
          className: cx('vg-seg__opt', on && 'is-on'), onClick: function () { pair[1](o.value); }
        }, o.label);
      }));
  }

  function Tabs(p) {
    var items = p.items || [];
    var pair = useControlled(p.value, p.defaultValue !== undefined ? p.defaultValue : (items[0] && items[0].id), p.onChange);
    return h('div', { className: cx('vg-tabs', p.className), role: 'tablist', 'aria-label': p.label },
      items.map(function (t) {
        var on = t.id === pair[0];
        return h('button', {
          key: t.id, type: 'button', role: 'tab', 'aria-selected': on, tabIndex: on ? 0 : -1,
          className: cx('vg-tab', on && 'is-on'), onClick: function () { pair[1](t.id); }
        }, t.label, t.count !== undefined ? h('span', { className: 'vg-tab__count' }, t.count) : null);
      }));
  }

  var fieldSeq = 0;
  function Field(p) {
    var idRef = React.useRef(p.id || 'vg-field-' + (++fieldSeq));
    var id = idRef.current;
    var note = p.error || p.hint;
    var rest = omit(p, ['label', 'hint', 'error', 'className', 'id', 'suffix']);
    return h('div', { className: cx('vg-field', p.error && 'is-invalid', p.className) },
      h('label', { className: 'vg-field__label', htmlFor: id }, p.label),
      h('div', { className: 'vg-field__box' },
        h('input', Object.assign({ id: id, className: 'vg-field__input', 'aria-invalid': p.error ? true : undefined,
          'aria-describedby': note ? id + '-note' : undefined }, rest)),
        p.suffix ? h('span', { className: 'vg-field__suffix' }, p.suffix) : null),
      note ? h('span', { id: id + '-note', className: 'vg-field__note' }, p.error ? 'Error — ' + p.error : p.hint) : null);
  }

  function port(side) {
    return function (pt) {
      return h('li', { key: pt.id || pt.label, className: cx('vg-port', 'vg-port--' + side, 'vg-port--' + (pt.type || 'asset'), pt.connected && 'is-linked') },
        h('i', { className: 'vg-port__pin', 'aria-hidden': true }),
        h('span', null, pt.label));
    };
  }
  function Node(p) {
    return h(Viewfinder, {
      active: p.selected, className: cx('vg-node', p.selected && 'is-selected', p.className),
      role: 'group', 'aria-label': p.title
    },
      h('header', { className: 'vg-node__head' },
        p.icon ? iconNode(p.icon) : null,
        h('span', { className: 'vg-node__kind' }, p.kind),
        p.status ? h('span', { className: 'vg-node__status' }, p.status) : null),
      h('div', { className: 'vg-node__title' }, p.title),
      p.children ? h('div', { className: 'vg-node__body' }, p.children) : null,
      h('div', { className: 'vg-node__ports' },
        h('ul', { className: 'vg-node__in' }, (p.inputs || []).map(port('in'))),
        h('ul', { className: 'vg-node__out' }, (p.outputs || []).map(port('out')))));
  }

  function Meter(p) {
    var max = p.max || 100;
    var value = Math.max(0, Math.min(max, p.value || 0));
    var pct = (value / max) * 100;
    var tone = p.tone || (p.low !== undefined && value <= p.low ? 'tally' : 'ink');
    return h('div', { className: cx('vg-meter', 'vg-meter--' + tone, p.className) },
      h('span', { className: 'vg-meter__label' }, p.label,
        tone === 'tally' ? h('b', { className: 'vg-meter__flag' }, p.flag || 'Low') : null),
      h('div', { className: 'vg-meter__track', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': p.label },
        h('i', { className: 'vg-meter__fill', style: { width: pct + '%' } })),
      h('span', { className: 'vg-meter__value' }, p.display !== undefined ? p.display : value));
  }

  var api = { Button: Button, Icon: Icon, Meta: Meta, Tally: Tally, Viewfinder: Viewfinder, WorldCard: WorldCard,
    Segmented: Segmented, Tabs: Tabs, Field: Field, Node: Node, Meter: Meter, icons: Object.keys(ICONS) };
  window.Visigame = Object.assign(window.Visigame || {}, api);
})();
