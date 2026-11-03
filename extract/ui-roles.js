// The UI graph's role rules (phase 7). Pure, no TypeScript. A control's role comes from, in order:
// `aria` (a literal role= on the element) then `native` (the HTML element's implicit role, below).
// `followed` (7b) and `mapped` (7e, designc.json ui.roles) come later. Nothing is guessed: an element
// that is a control but has no implicit role gets role null and an unresolved entry.

// Roles a person interacts with. A literal role= outside this set is not a control (role="presentation").
const WIDGET_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell', 'scrollbar']);

// input type -> implicit role (HTML-AAM). Types with no role stay null (date, time, color, file...).
const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio',
  range: 'slider', number: 'spinbutton', search: 'searchbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  password: 'textbox' };
const LIST_TYPES = new Set(['text', 'search', 'email', 'tel', 'url']);

// The elements that are controls at all. `a` only with href; `input type=hidden` never.
const NATIVE = new Set(['button', 'a', 'input', 'select', 'textarea']);

/* attrs: {name: {literal: string|null, present: true}}. Returns
   {control: false} | {control: true, role, basis, reason?} where reason explains a null role. */
function roleOf(tag, attrs) {
  const lit = k => (attrs[k] && attrs[k].literal != null ? attrs[k].literal : null);
  const aria = lit('role');
  if (aria != null) {
    const first = aria.trim().split(/\s+/)[0];
    if (WIDGET_ROLES.has(first)) return { control: true, role: first, basis: 'aria' };
    return { control: false };
  }
  if (attrs.role) return { control: NATIVE.has(tag), role: null, basis: null, reason: 'role is not a literal' };
  if (!NATIVE.has(tag)) return { control: false };
  if (tag === 'button') return { control: true, role: 'button', basis: 'native' };
  if (tag === 'textarea') return { control: true, role: 'textbox', basis: 'native' };
  if (tag === 'a') return attrs.href ? { control: true, role: 'link', basis: 'native' } : { control: false };
  if (tag === 'select') {
    if (attrs.multiple) return { control: true, role: 'listbox', basis: 'native' };
    const size = lit('size');
    if (attrs.size && size == null) return { control: true, role: null, basis: null, reason: 'select size is not a literal' };
    return { control: true, role: size != null && Number(size) > 1 ? 'listbox' : 'combobox', basis: 'native' };
  }
  // input
  if (attrs.type && lit('type') == null) return { control: true, role: null, basis: null, reason: 'input type is not a literal' };
  const type = (lit('type') || 'text').toLowerCase();
  if (type === 'hidden') return { control: false };
  if (attrs.list && LIST_TYPES.has(type)) return { control: true, role: 'combobox', basis: 'native' };
  const role = INPUT_ROLES[type];
  return role ? { control: true, role, basis: 'native' } : { control: true, role: null, basis: null, reason: `input type "${type}" has no implicit role` };
}

// Roles whose accessible name may come from their content (ARIA "name from content").
const NAME_FROM_CONTENT = new Set(['button', 'link', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'switch', 'checkbox', 'radio', 'gridcell']);

// Accessible-name precedence (accname 1.2, simplified to what source can show): the first literal wins. t('key') and
// expressions are kept in names but never become the name: the visible text is not in the source.
const NAME_ORDER = ['aria-labelledby', 'aria-label', 'label', 'alt', 'text', 'value', 'title', 'placeholder'];

module.exports = { roleOf, WIDGET_ROLES, NAME_FROM_CONTENT, NAME_ORDER };
