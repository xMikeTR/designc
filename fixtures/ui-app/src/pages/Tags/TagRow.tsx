type Props = { name: string; onEdit: () => void };

export const TagRow = ({ name, onEdit }: Props) => (
  <li>
    {name}
    <button aria-label={`Edit ${name}`} onClick={onEdit}>Edit</button>
  </li>
);
