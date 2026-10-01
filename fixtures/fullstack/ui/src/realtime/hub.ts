import { HubConnectionBuilder } from '@microsoft/signalr';

export const hubConnection = new HubConnectionBuilder()
  .withUrl(import.meta.env.VITE_HUB_URL)
  .build();
