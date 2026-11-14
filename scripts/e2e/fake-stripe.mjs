import crypto from 'node:crypto';
import http from 'node:http';

const json = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
};

const stripeId = (prefix, runId, sequence) => `${prefix}_cenaqa${runId}${sequence}`;

export function createFakeStripe({ webhookUrl, webhookSecret, runId = String(Date.now()) }) {
  const accounts = new Map();
  const sessions = new Map();
  const intents = new Map();
  const refunds = new Map();
  const audit = [];
  let sequence = 0;

  const nextId = prefix => stripeId(prefix, runId, ++sequence);
  const server = http.createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin || '*');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/__qa/audit' && request.method === 'GET') {
        return json(response, 200, audit);
      }
      if (url.pathname.startsWith('/__qa/pay/') && request.method === 'POST') {
        const sessionId = decodeURIComponent(url.pathname.slice('/__qa/pay/'.length));
        const session = sessions.get(sessionId);
        if (!session || session.status !== 'open') return json(response, 409, { error: 'session is unavailable' });
        const intent = intents.get(session.payment_intent);
        session.status = 'complete';
        session.payment_status = 'paid';
        session.created = Math.floor(Date.now() / 1000);
        intent.status = 'succeeded';
        intent.amount_received = intent.amount;
        intent.latest_charge = { id: nextId('ch'), created: session.created };

        const event = {
          id: nextId('evt'), type: 'checkout.session.completed', created: session.created,
          account: session.account, data: { object: session },
        };
        const payload = JSON.stringify(event);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = crypto.createHmac('sha256', webhookSecret)
          .update(`${timestamp}.${payload}`).digest('hex');
        const webhook = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
          body: payload,
        });
        const webhookBody = await webhook.json().catch(() => ({}));
        audit.push({ kind: 'webhook', eventId: event.id, status: webhook.status, orderId: session.metadata.cena_order_id });
        return json(response, webhook.ok ? 200 : 502, {
          paid: webhook.ok, webhookStatus: webhook.status, response: webhookBody,
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/accounts') {
        const fields = await readForm(request);
        const id = nextId('acct');
        const account = { id, charges_enabled: true, payouts_enabled: true };
        accounts.set(id, account);
        audit.push({ kind: 'account_create', id, restaurantId: fields.get('metadata[cena_restaurant_id]') });
        return json(response, 200, account);
      }
      if (request.method === 'GET' && /^\/v1\/accounts\/acct_[A-Za-z0-9]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1);
        const account = accounts.get(id) || { id, charges_enabled: true, payouts_enabled: true };
        return json(response, 200, account);
      }
      if (request.method === 'POST' && url.pathname === '/v1/account_links') {
        const fields = await readForm(request);
        audit.push({ kind: 'account_link', account: fields.get('account') });
        return json(response, 200, { url: `https://connect.stripe.com/test/${fields.get('account')}` });
      }
      if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const fields = await readForm(request);
        const orderId = fields.get('metadata[cena_order_id]');
        const account = request.headers['stripe-account'];
        const amount = Number(fields.get('line_items[0][price_data][unit_amount]'));
        const fee = Number(fields.get('payment_intent_data[application_fee_amount]'));
        if (!orderId || !account || !Number.isInteger(amount) || !Number.isInteger(fee) || fee < 150 || fee > 200) {
          return json(response, 400, { error: 'invalid fake Checkout request' });
        }
        const id = nextId('cs');
        const paymentIntent = nextId('pi');
        const session = {
          id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid',
          amount_total: amount, currency: fields.get('line_items[0][price_data][currency]'),
          client_reference_id: fields.get('client_reference_id'), expires_at: Number(fields.get('expires_at')),
          created: Math.floor(Date.now() / 1000), payment_intent: paymentIntent,
          payment_method_types: [fields.get('payment_method_types[0]')], account,
          metadata: {
            order_id: fields.get('metadata[order_id]'), cena_order_id: orderId,
            application_fee_cents: fields.get('metadata[application_fee_cents]'),
          },
        };
        intents.set(paymentIntent, {
          id: paymentIntent, status: 'requires_payment_method', currency: session.currency,
          amount, amount_received: 0, application_fee_amount: fee,
          metadata: {
            order_id: orderId,
            cena_order_id: fields.get('payment_intent_data[metadata][cena_order_id]'),
          }, latest_charge: null,
        });
        sessions.set(id, session);
        audit.push({ kind: 'checkout_session', sessionId: id, orderId, account, amountCents: amount, feeCents: fee });
        return json(response, 200, session);
      }
      const sessionMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9]+)(\/expire)?$/);
      if (sessionMatch && request.method === 'GET') {
        const session = sessions.get(sessionMatch[1]);
        return session ? json(response, 200, session) : json(response, 404, { error: 'unknown session' });
      }
      if (sessionMatch && request.method === 'POST' && sessionMatch[2] === '/expire') {
        const session = sessions.get(sessionMatch[1]);
        if (!session) return json(response, 404, { error: 'unknown session' });
        if (session.status === 'open') {
          session.status = 'expired';
          session.payment_status = 'unpaid';
        }
        audit.push({ kind: 'session_expire', sessionId: session.id });
        return json(response, 200, session);
      }
      const intentMatch = url.pathname.match(/^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)$/);
      if (intentMatch && request.method === 'GET') {
        const intent = intents.get(intentMatch[1]);
        return intent ? json(response, 200, intent) : json(response, 404, { error: 'unknown intent' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/refunds') {
        const fields = await readForm(request);
        const intent = intents.get(fields.get('payment_intent'));
        if (!intent || intent.status !== 'succeeded') return json(response, 400, { error: 'payment is not refundable' });
        const id = nextId('re');
        const refund = {
          id, status: 'succeeded', payment_intent: intent.id,
          currency: intent.currency, amount: Number(fields.get('amount')),
          metadata: {
            cena_order_id: fields.get('metadata[cena_order_id]'),
            cena_refund_attempt: fields.get('metadata[cena_refund_attempt]'),
          },
        };
        refunds.set(id, refund);
        audit.push({ kind: 'refund', refundId: id, account: request.headers['stripe-account'], amountCents: refund.amount });
        return json(response, 200, refund);
      }
      const refundMatch = url.pathname.match(/^\/v1\/refunds\/(re_[A-Za-z0-9]+)$/);
      if (refundMatch && request.method === 'GET') {
        const refund = refunds.get(refundMatch[1]);
        return refund ? json(response, 200, refund) : json(response, 404, { error: 'unknown refund' });
      }
      return json(response, 404, { error: 'unknown fake Stripe endpoint' });
    } catch (error) {
      audit.push({ kind: 'fake_server_error', message: error instanceof Error ? error.message : String(error) });
      return json(response, 500, { error: 'fake Stripe request failed' });
    }
  });

  return {
    audit,
    sessions,
    intents,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function readForm(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
