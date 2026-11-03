import { memo } from 'react';

// An icon button: its name comes from the label prop, not from its content.
export const IconButton = memo((props: { label: string; onClick?: () => void; children?: React.ReactNode }) => (
  <button type="button" aria-label={props.label} onClick={props.onClick}>{props.children}</button>
));
