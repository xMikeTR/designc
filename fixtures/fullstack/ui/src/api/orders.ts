import { client } from './client';

export function getOrder(id: string) {
  return client.get(`/v1/orders/${id}`);
}

export function createOrder(order: unknown) {
  return client.post('/v1/orders', order);
}

export function getCustomer(id: string) {
  return fetch('/api/v1/customers/' + id);
}
