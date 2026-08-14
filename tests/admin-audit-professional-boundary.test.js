import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliverProfessionalCapability,
  getProfessionalHandler,
  listProfessionalHandlers,
} from '../scripts/host/professional-capability/index.mjs';

const capability = 'admin.audit-telemetry';
const context = { events: [{ type: 'caller.supplied', at: 'untrusted' }] };
const rejection = {
  code: 'PROFESSIONAL_DEDICATED_CAPABILITY_ENTRYPOINT',
  status: 403,
};

test('admin audit telemetry is unavailable through generic professional delivery', async () => {
  await assert.rejects(deliverProfessionalCapability(capability, context), rejection);
  assert.throws(() => getProfessionalHandler(capability), rejection);
  assert.equal(listProfessionalHandlers().includes(capability), false);
});

test('application professional delivery rejects the generic admin audit path', async () => {
  const application = {
    professionalCapabilities: { deliver: deliverProfessionalCapability },
  };
  await assert.rejects(
    application.professionalCapabilities.deliver(capability, context),
    rejection,
  );
});
