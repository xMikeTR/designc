type Props = { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>;

// A labelled input: the label wraps the input, the rest of the props go to the input.
export function Field({ label, hint = 'Optional', ...rest }: Props) {
  return (
    <label>
      {label}
      <input {...rest} title={hint} />
    </label>
  );
}
