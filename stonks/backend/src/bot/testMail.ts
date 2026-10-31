// Sends the sample trade mail from the server: `[test-mail]` in a commit message runs this after the deploy.

import { sendTestAlert } from './tradeMail.js';

const result = await sendTestAlert();
console.log(result.ok ? 'Test mail handed to SendGrid' : `Test mail not sent: ${result.error}`);
process.exit(result.ok ? 0 : 1);
