import { PublicClientApplication } from '@azure/msal-browser';

export const msalInstance = new PublicClientApplication({
  auth: {
    clientId: 'ui-app-client-id',
    authority: 'https://login.microsoftonline.com/common',
  },
});
