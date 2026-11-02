import { useState } from 'react';
import { t } from '../../i18n';
import { TagRow } from './TagRow';

export function TagsPage() {
  const [query, setQuery] = useState('');
  const label = 'Dynamic';
  const tags = ['urgent', 'later'];
  return (
    <main>
      <h1>Tags</h1>
      <label htmlFor="tag-search">Search tags</label>
      <input id="tag-search" type="search" value={query} onChange={e => setQuery(e.target.value)} />
      <label>
        Show archived
        <input type="checkbox" />
      </label>
      <select aria-label="Sort by">
        <option>Name</option>
      </select>
      <textarea placeholder="Notes" />
      <button type="button" onClick={() => setQuery('')}>Clear</button>
      <button>{t('tags.save')}</button>
      <button title="Delete tag">{label}</button>
      <a href="/tags/new">New tag</a>
      <a>Not a link</a>
      <div role="switch" aria-label="Compact view" />
      <div role="presentation">Layout only</div>
      <input type="date" aria-label="Created after" />
      <input type="hidden" name="csrf" />
      <span id="filter-label">Filter</span>
      <input type="text" aria-labelledby="filter-label" />
      <ul>{tags.map(tag => <TagRow key={tag} name={tag} onEdit={() => setQuery(tag)} />)}</ul>
    </main>
  );
}
