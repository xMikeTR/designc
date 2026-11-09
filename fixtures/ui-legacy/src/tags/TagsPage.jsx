import React from 'react';
import { KitButton } from 'legacy-kit';

// The legacy tags page (synthetic, slice 7e): plain JSX, a kit button mapped by designc.json ui.roles.
export default function TagsPage({ tags, canEdit }) {
  return (
    <div>
      <label htmlFor="q">Find tag</label>
      <input id="q" type="search" />
      {canEdit ? <KitButton label="Add tag" onClick={() => {}} /> : null}
      <table>
        <tbody>
          {tags.map(t => <tr key={t.id}><td>{t.name}</td><td>{new Date(t.created).toLocaleDateString('en-GB')}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
