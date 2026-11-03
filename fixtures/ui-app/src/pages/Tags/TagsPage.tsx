import { useState } from 'react';
import { t } from '../../i18n';
import { TagRow } from './TagRow';
import { Field } from '@/components/Field';
import { IconButton } from '@/components/IconButton';
import { Button, Badge } from 'ui-lib';

export function TagsPage() {
  const [query, setQuery] = useState('');
  const label = 'Dynamic';
  const tags = ['urgent', 'later'];
  const [loading] = useState(false);
  const canEdit = tags.length > 0;
  if (loading) return <p>Loading tags</p>;
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
      <button type="button" onClick={() => setQuery('')} disabled={!query}>Clear</button>
      <button>{t('tags.save')}</button>
      <button title="Delete tag">{label}</button>
      {canEdit && <a href="/tags/new">New tag</a>}
      {canEdit ? <button>Rename</button> : <span>Read only</span>}
      <a>Not a link</a>
      <div role="switch" aria-label="Compact view" />
      <div role="presentation">Layout only</div>
      <input type="date" aria-label="Created after" />
      <input type="hidden" name="csrf" />
      <span id="filter-label">Filter</span>
      <input type="text" aria-labelledby="filter-label" />
      <Field label="Tag name" type="text" name="name" required />
      <IconButton label="Refresh" onClick={() => setQuery('')}>↻</IconButton>
      <Button onClick={() => setQuery('')}>Reset</Button>
      <Badge>{tags.length}</Badge>
      <ul>{tags.map(tag => <TagRow key={tag} name={tag} onEdit={() => setQuery(tag)} />)}</ul>
    </main>
  );
}
