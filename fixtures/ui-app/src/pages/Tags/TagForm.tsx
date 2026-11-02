import { useForm } from 'react-hook-form';
import { z } from 'zod';
import * as yup from 'yup';
import { format } from 'date-fns';
import dayjs from 'dayjs';

const tagSchema = z.object({
  name: z.string().min(1).max(40),
  colour: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});
const noteSchema = yup.object().shape({ note: yup.string().max(200) });

export function TagForm({ created, share, locale }: { created: Date; share: number; locale: string }) {
  const { register } = useForm();
  return (
    <form>
      <input aria-label="Tag name" {...register('name', { required: 'Name is required', maxLength: { value: 40, message: 'Too long' } })} />
      <input aria-label="Colour" {...register('colour')} />
      <textarea aria-label="Note" {...register('note')} />
      <input aria-label="Owner" {...register('owner')} />
      <p>Created {format(created, 'dd/MM/yyyy')}</p>
      <p>Updated {dayjs(created).format('D MMM YYYY')}</p>
      <p>{new Intl.NumberFormat('en-GB', { style: 'percent' }).format(share)}</p>
      <time>{created.toLocaleDateString(locale)}</time>
      <button type="submit">Save {created.toLocaleTimeString('en-GB')}</button>
    </form>
  );
}
