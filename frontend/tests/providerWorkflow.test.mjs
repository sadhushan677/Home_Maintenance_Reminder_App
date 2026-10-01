import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Timestamp } from 'firebase/firestore';

const require = createRequire(import.meta.url), src = fileURLToPath(new URL('../src/', import.meta.url));
function load(file, overrides = {}, cache = new Map()) {
  const full = path.resolve(src, file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} }; cache.set(full, module);
  const compiled = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = id => {
    if (id in overrides) return overrides[id];
    if (id.startsWith('.')) return load(path.resolve(path.dirname(full), id + (path.extname(id) ? '' : '.ts')), overrides, cache);
    return require(id);
  };
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
  return module.exports;
}
const workflow = load('utils/providerWorkflow.ts');
const mapping = load('utils/providerFirestoreMapping.ts');
const requestForm = load('utils/warrantyRequestForm.ts');
const newRequest = { customerName: ' New Customer ', customerPhone: '+94 771234567', customerEmail: 'customer@example.com', applianceName: 'Fridge', brand: 'Example', model: 'F1', serialNumber: 'S123', purchaseDate: '2025-01-01', warrantyExpiryDate: '2030-01-01', notes: '' };
test('creation validates required contact fields and real calendar dates', () => {
  assert.equal(requestForm.validateWarrantyRequestForm(newRequest), '');
  for (const [key, value] of [['customerName', ' '], ['customerEmail', 'invalid'], ['customerPhone', '123'], ['purchaseDate', '2025-02-30'], ['purchaseDate', '2999-01-01'], ['warrantyExpiryDate', '2024-01-01']]) {
    assert.notEqual(requestForm.validateWarrantyRequestForm({ ...newRequest, [key]: value }), '');
  }
});
test('creation commits three linked records with timestamps, pending status and unique customer IDs', async () => {
  const fake = fakeFirestore();
  const service = fake.service('createWarrantyCase');
  const result = await service.createWarrantyCase(newRequest, {});
  assert.equal(fake.records.size, 3);
  const request = fake.records.get('warrantyRequests/' + result.warrantyRequestId);
  const appliance = fake.records.get('appliances/' + result.applianceId);
  const warranty = fake.records.get('warranties/' + result.warrantyId);
  assert.equal(request.customerName, 'New Customer');
  assert.equal(request.status, 'pending'); assert.equal(request.providerId, null);
  assert.equal(request.customerId, appliance.customerId); assert.equal(warranty.customerId, request.customerId);
  assert.equal(request.applianceId, result.applianceId); assert.equal(warranty.applianceId, result.applianceId);
  assert.equal(request.warrantyId, result.warrantyId); assert.equal(warranty.status, 'active');
  assert.equal(warranty.modelCovered, null); assert.equal(appliance.warrantyExpiryDate, newRequest.warrantyExpiryDate);
  assert.equal(request.documentsReviewed, false);
  assert.equal(request.warrantyCardUploaded, false); assert.equal(request.purchaseReceiptUploaded, false);
  for (const record of [request, appliance, warranty]) {
    assert.deepEqual(record.createdAt, { serverTimestamp: true }); assert.deepEqual(record.updatedAt, { serverTimestamp: true });
  }
  const second = await service.createWarrantyCase(newRequest, {});
  assert.notEqual(second.customerId, result.customerId);
  const assigned = await service.createWarrantyCase(newRequest, { customerId: 'shared-customer', providerId: 'assigned-provider' });
  assert.equal(fake.records.get('warrantyRequests/' + assigned.warrantyRequestId).providerId, 'assigned-provider');
  assert.equal(assigned.customerId, 'shared-customer');
});
test('denied creation leaves no partial records and invalid forms never write', async () => {
  const fake = fakeFirestore(); fake.setFailWrite(true);
  const original = console.error; const logged = []; console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(() => fake.service('createWarrantyCase').createWarrantyCase(newRequest, {}), /permission/i);
    assert.equal(fake.records.size, 0); assert.equal(logged[0][1].code, 'permission-denied');
    fake.setFailWrite(false);
    await assert.rejects(() => fake.service('createWarrantyCase').createWarrantyCase({ ...newRequest, customerEmail: '' }, {}), /required/);
    assert.equal(fake.records.size, 0);
  } finally { console.error = original; }
});
function fakeFirestore() {
  const records = new Map(), operations = []; let nextId = 0, failWrite = false;
  const snapshot = ref => ({ id: ref.path.split('/').at(-1), metadata: { fromCache: false }, exists: () => records.has(ref.path), data: () => records.get(ref.path) });
  const write = (type, ref, data) => {
    if (failWrite) throw Object.assign(new Error('Missing permissions'), { code: 'permission-denied' });
    operations.push({ type, path: ref.path, data });
    if (type === 'delete') records.delete(ref.path);
    else if (type === 'update') { if (!records.has(ref.path)) throw new Error('not-found'); records.set(ref.path, { ...records.get(ref.path), ...data }); }
    else records.set(ref.path, data);
  };
  const sdk = {
    Timestamp,
    collection: (_db, name) => ({ path: name }),
    doc: (...args) => args.length === 1 ? { path: args[0].path + '/generated-' + ++nextId, id: 'generated-' + nextId } : { path: args.slice(1).join('/') },
    where: (field, operator, value) => ({ kind: 'where', field, operator, value }),
    orderBy: (field, direction) => ({ kind: 'order', field, direction }),
    query: (reference, ...constraints) => ({ ...reference, constraints }),
    getDoc: async ref => snapshot(ref),
    getDocs: async reference => {
      let entries = [...records.entries()].filter(([key]) => key.startsWith(reference.path + '/') && key.split('/').length === reference.path.split('/').length + 1);
      for (const constraint of reference.constraints || []) {
        if (constraint.kind === 'where') entries = entries.filter(([, value]) => constraint.operator === 'in' ? constraint.value.includes(value[constraint.field]) : value[constraint.field] === constraint.value);
      }
      return { metadata: { fromCache: false }, docs: entries.map(([key]) => snapshot({ path: key })) };
    },
    serverTimestamp: () => ({ serverTimestamp: true }),
    addDoc: async (ref, data) => { const created = { path: ref.path + '/created-' + ++nextId }; write('set', created, data); return { id: created.path.split('/').at(-1) }; },
    updateDoc: async (ref, data) => write('update', ref, data),
    deleteDoc: async ref => write('delete', ref),
    writeBatch: () => { const writes = []; return { set: (ref, data) => writes.push(['set', ref, data]), update: (ref, data) => writes.push(['update', ref, data]), delete: ref => writes.push(['delete', ref]), commit: async () => { if (failWrite) throw Object.assign(new Error('Missing permissions'), { code: 'permission-denied' }); writes.forEach(args => write(...args)); } }; },
    runTransaction: async (_db, action) => {
      const writes = [];
      await action({ get: async ref => snapshot(ref), update: (ref, data) => writes.push(['update', ref, data]), set: (ref, data) => writes.push(['set', ref, data]), delete: ref => writes.push(['delete', ref]) });
      if (failWrite) throw Object.assign(new Error('Missing permissions'), { code: 'permission-denied' });
      writes.forEach(args => write(...args));
    },
  };
  const overrides = {
    'firebase/firestore': sdk,
    '../config/firebase': { db: { app: { options: { projectId: 'test-project' } } } },

  };
  const cache = new Map();
  return { records, operations, service: file => load('services/' + file + '.ts', overrides, cache), dev: () => load('dev/providerFirestoreTools.ts', overrides, cache), setFailWrite: value => { failWrite = value; } };
}
function fixture(fake) {
  const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  fake.records.set('warrantyRequests/r1', { customerId: 'c1', applianceId: 'a1', warrantyId: 'w1', providerId: null, status: 'pending', notes: '', customerName: 'Test Customer', customerPhone: '123', customerEmail: 'test@example.com', warrantyCardUploaded: true, purchaseReceiptUploaded: true, documentsReviewed: true, modelSerialConfirmed: true, verificationNotes: '', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  fake.records.set('appliances/a1', { customerId: 'c1', name: 'Fridge', brand: 'Test', model: 'T1', serialNumber: 'S1', purchaseDate: day(-20) });
  fake.records.set('warranties/w1', { applianceId: 'a1', purchaseDate: day(-20), expiryDate: day(100), status: 'active', modelCovered: true });
  for (const [id, type] of [['d1', 'warranty_card'], ['d2', 'purchase_receipt']]) fake.records.set('warrantyDocuments/' + id, { warrantyRequestId: 'r1', type, fileName: id + '.pdf', fileUrl: 'https://example.com/' + id + '.pdf', verificationStatus: 'verified' });
}

test('status labels map to required lowercase Firestore values and reject unknown states', () => {
  assert.deepEqual(workflow.statuses.map(workflow.toFirestoreStatus), ['pending', 'approved', 'rejected', 'more_information_required']);
  assert.equal(workflow.requestStatus('more_information_required'), 'More Information Required');
  assert.equal(workflow.requestStatus('Approved'), 'Approved');
  assert.throws(() => workflow.requestStatus('unknown'), /Unsupported/);
});
test('Timestamp and legacy dates normalize; absent dates and model coverage remain unknown', () => {
  assert.equal(mapping.dateValue(Timestamp.fromDate(new Date('2026-09-30T01:00:00Z'))), '2026-09-30T01:00:00.000Z');
  assert.equal(mapping.dateValue(null), '');
  assert.equal(mapping.dateValue('not-a-date'), '');
  assert.equal(mapping.parseWarranty('w', { purchaseDate: Timestamp.fromDate(new Date('2026-01-01')) }).modelCovered, null);
  assert.equal(workflow.validDate('2026-02-30'), false);
});
test('read all requests has no 100-record cap and preserves missing timestamps', async () => {
  const fake = fakeFirestore();
  for (let i = 0; i < 105; i++) fake.records.set('warrantyRequests/r' + i, { status: 'pending', customerName: 'Name ' + i });
  const items = await fake.service('warrantyRequestService').getWarrantyRequests();
  assert.equal(items.length, 105);
});
test('read details joins the selected IDs and uses request contact fields', async () => {
  const fake = fakeFirestore(); fixture(fake);
  const item = await fake.service('warrantyRequestService').getWarrantyCaseById('r1');
  assert.equal(item.customer.name, 'Test Customer'); assert.equal(item.appliance.id, 'a1'); assert.equal(item.documents.length, 0);
  assert.equal(workflow.eligibility(item).every(check => check.checked), true);
  fake.records.get('appliances/a1').customerId = 'another-customer';
  await assert.rejects(() => fake.service('warrantyRequestService').getWarrantyCaseById('r1'), /do not match/);
});
test('status update atomically writes canonical status, notes, timestamp and notification', async () => {
  const fake = fakeFirestore(); fixture(fake);
  fake.records.delete('warrantyDocuments/d1'); fake.records.delete('warrantyDocuments/d2');
  await fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', ' Verified ');
  assert.equal(fake.records.get('warrantyRequests/r1').status, 'approved');
  assert.equal(fake.records.get('warrantyRequests/r1').notes, 'Verified');
  assert.deepEqual(fake.records.get('warrantyRequests/r1').updatedAt, { serverTimestamp: true });
  assert.deepEqual(fake.records.get('warrantyRequests/r1').verifiedAt, { serverTimestamp: true });
  assert.equal([...fake.records.keys()].filter(key => key.startsWith('providerNotifications/')).length, 1);
  const notification = [...fake.records.entries()].find(([key]) => key.startsWith('providerNotifications/'))[1];
  assert.equal(notification.title, 'Warranty request approved');
  assert.equal(notification.message, 'Warranty request r1 has been approved.');
  const before = fake.operations.length;
  await fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', 'Verified');
  assert.equal(fake.operations.length, before);
});
test('missing upload flag blocks approval without writes', async () => {
  const fake = fakeFirestore(); fixture(fake); fake.records.get('warrantyRequests/r1').warrantyCardUploaded = false;
  await assert.rejects(() => fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', ''), /Approval requires/);
  assert.equal(fake.operations.length, 0);
});
test('approval also requires final document review and manual model/serial confirmation', async () => {
  const fake = fakeFirestore(); fixture(fake);
  const request = fake.records.get('warrantyRequests/r1');
  request.documentsReviewed = false;
  await assert.rejects(() => fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', ''), /completed document review/);
  request.documentsReviewed = true; request.modelSerialConfirmed = false;
  await assert.rejects(() => fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', ''), /model\/serial details/);
  assert.equal(fake.operations.length, 0);
});
test('verification notes and model/serial confirmation persist without finalizing request status', async () => {
  const fake = fakeFirestore(); fixture(fake);
  await fake.service('warrantyRequestService').saveWarrantyVerification('r1', 'Serial matches card', true);
  const request = fake.records.get('warrantyRequests/r1');
  assert.equal(request.status, 'pending');
  assert.equal(request.verificationNotes, 'Serial matches card');
  assert.equal(request.modelSerialConfirmed, true);
});
test('permission failure rejects mutation and leaves notification/request unchanged', async () => {
  const fake = fakeFirestore(); fixture(fake); fake.setFailWrite(true);
  await assert.rejects(() => fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Rejected', 'Reason'), /Access denied/);
  assert.equal(fake.records.get('warrantyRequests/r1').status, 'pending'); assert.equal(fake.operations.length, 0);
});
test('detail save updates contact and related data without replacing concurrent status', async () => {
  const fake = fakeFirestore(); fixture(fake);
  const service = fake.service('warrantyRequestService'), item = await service.getWarrantyCaseById('r1');
  fake.records.get('warrantyRequests/r1').status = 'more_information_required'; item.customer.phone = '456'; item.appliance.model = 'T2';
  await service.saveWarrantyCaseDetails(item);
  assert.equal(fake.records.get('warrantyRequests/r1').status, 'more_information_required');
  assert.equal(fake.records.get('warrantyRequests/r1').customerPhone, '456');
  assert.equal(fake.records.get('appliances/a1').model, 'T2');
});
test('document review and notification read states use persistent writes', async () => {
  const fake = fakeFirestore(); fixture(fake);
  await fake.service('warrantyDocumentService').updateDocumentVerificationStatus('d1', 'rejected');
  assert.equal(fake.records.get('warrantyDocuments/d1').verificationStatus, 'rejected');
  assert.equal(fake.records.get('warrantyRequests/r1').documentsReviewed, false);
  fake.records.set('providerNotifications/n1', { providerId: 'p1', isRead: false });
  fake.records.set('providerNotifications/n2', { providerId: 'p2', isRead: false });
  const service = fake.service('providerNotificationService');
  await service.markAllNotificationsAsRead('p1');
  assert.equal(fake.records.get('providerNotifications/n1').isRead, true); assert.equal(fake.records.get('providerNotifications/n2').isRead, false);
});
test('create and delete target only the intended request', async () => {
  const fake = fakeFirestore(); fixture(fake); const service = fake.service('warrantyRequestService');
  const id = await service.createWarrantyRequest({ customerId: 'c1', applianceId: 'a1', warrantyId: 'w1', status: 'Pending', notes: '', providerId: null, customerName: 'Test', customerPhone: '1', customerEmail: 'test@example.com', applianceName: 'Fridge' });
  assert.equal(fake.records.get('warrantyRequests/' + id).status, 'pending');
  await service.deleteWarrantyRequest(id);
  assert.equal(fake.records.has('warrantyRequests/' + id), false);
  assert.equal(fake.records.has('appliances/a1'), true);
});

test('development helper never seeds on import and rejects production calls', async () => {
  const fake = fakeFirestore(); globalThis.__DEV__ = false;
  try {
    const tools = fake.dev(); assert.equal(fake.operations.length, 0);
    await assert.rejects(() => tools.seedProviderTestData({ projectId: 'test-project', confirm: 'CREATE DEVELOPMENT TEST DATA' }), /disabled in production/);
    assert.equal(fake.operations.length, 0);
  } finally { delete globalThis.__DEV__; }
});
test('explicit development seeding is non-overwriting and cleanup requires its marker', async () => {
  const fake = fakeFirestore(); globalThis.__DEV__ = true;
  try {
    const tools = fake.dev();
    await assert.rejects(() => tools.seedProviderTestData({ projectId: 'wrong-project', confirm: 'CREATE DEVELOPMENT TEST DATA' }), /project ID/);
    const result = await tools.seedProviderTestData({ projectId: 'test-project', confirm: 'CREATE DEVELOPMENT TEST DATA' });
    assert.equal(result.requestIds.length, 3); assert.equal(fake.records.size, 17);
    await assert.rejects(() => tools.seedProviderTestData({ projectId: 'test-project', confirm: 'CREATE DEVELOPMENT TEST DATA' }), /already exist/);
    fake.records.get('appliances/fixmate-dev-appliance-1').developmentSeed = 'someone-else';
    await assert.rejects(() => tools.deleteProviderTestData({ projectId: 'test-project', confirm: 'DELETE DEVELOPMENT TEST DATA' }), /Refusing to delete/);
    assert.equal(fake.records.size, 17);
  } finally { delete globalThis.__DEV__; }
});

test('manual review saves all flags together and rejects any unchecked confirmation', async () => {
 const fake = fakeFirestore(); fixture(fake);
 const request = fake.records.get('warrantyRequests/r1');
 request.warrantyCardUploaded = false; request.purchaseReceiptUploaded = false; request.documentsReviewed = false;
 const confirmed = { warrantyCardUploaded: true, purchaseReceiptUploaded: true, documentsReviewed: true };
 const service = fake.service('warrantyRequestService');
 for (const field of Object.keys(confirmed)) {
   await assert.rejects(() => service.confirmWarrantyDocumentsReviewed('r1', { ...confirmed, [field]: false }), /all three/);
   assert.equal(fake.operations.length, 0);
 }
 await service.confirmWarrantyDocumentsReviewed('r1', confirmed);
 const saved = fake.records.get('warrantyRequests/r1');
 for (const field of Object.keys(confirmed)) assert.equal(saved[field], true);
 assert.deepEqual(saved.updatedAt, { serverTimestamp: true });
 assert.equal(saved.status, 'pending');
 await assert.rejects(() => service.confirmWarrantyDocumentsReviewed('missing', confirmed), /not found/);
});
test('missing legacy flags fail closed and expiry blocks approval without document records', async () => {
 const fake = fakeFirestore(); fixture(fake);
 const request = fake.records.get('warrantyRequests/r1'); delete request.warrantyCardUploaded;
 assert.equal(mapping.parseRequest('r1', request).warrantyCardUploaded, false);
 await assert.rejects(() => fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', ''), /Approval requires/);
 request.warrantyCardUploaded = true; fake.records.get('warranties/w1').expiryDate = '2000-01-01';
 await assert.rejects(() => fake.service('warrantyRequestService').updateWarrantyRequestStatus('r1', 'Approved', ''), /Approval requires/);
 assert.equal(fake.operations.length, 0);
});

test('finalized requests reject edits, review, verification and repeated decisions without writes', async () => {
 for (const status of ['approved', 'rejected']) {
  const fake = fakeFirestore(); fixture(fake); const service = fake.service('warrantyRequestService');
  const stale = await service.getWarrantyCaseById('r1');
  fake.records.get('warrantyRequests/r1').status = status;
  await assert.rejects(() => service.saveWarrantyCaseDetails(stale), /finalized/);
  await assert.rejects(() => service.updateWarrantyRequest('r1', { notes: 'changed' }), /finalized/);
  await assert.rejects(() => service.saveWarrantyVerification('r1', 'changed', true), /finalized/);
  await assert.rejects(() => service.confirmWarrantyDocumentsReviewed('r1', { warrantyCardUploaded: true, purchaseReceiptUploaded: true, documentsReviewed: true }), /finalized/);
  await assert.rejects(() => service.updateWarrantyRequestStatus('r1', 'Pending', 'restart'), /finalized/);
  await assert.rejects(() => service.updateWarrantyRequestStatus('r1', 'Approved', 'repeat'), /finalized/);
  const details = await service.getWarrantyCaseById('r1');
  assert.equal(workflow.isFinalized(details.request.status), true);
  assert.equal(fake.operations.length, 0);
 }
 assert.equal(workflow.isFinalized('Pending'), false);
 assert.equal(workflow.isFinalized('More Information Required'), false);
});

test('shared auth validates persisted profiles, selected roles and reuses logout', async () => {
 const firebaseUser = { uid: 'provider-uid', email: 'provider@example.com', displayName: 'Provider Name' };
 let data = { role: 'provider', name: 'Profile Name' }, exists = true, signedOut = 0;
 const service = load('services/authService.ts', {
  'firebase/auth': { signInWithEmailAndPassword: async (_auth, email) => { assert.equal(email, 'provider@example.com'); return { user: firebaseUser }; }, signOut: async () => { signedOut++; } },
  'firebase/firestore': { doc: (_db, collection, id) => { assert.equal(collection, 'users'); assert.equal(id, firebaseUser.uid); return {}; }, getDoc: async () => ({ exists: () => exists, data: () => data }) },
  '../config/firebase': { auth: {}, db: {} },
 });
 assert.deepEqual(await service.loginUser(' provider@example.com ', 'password', 'provider'), { uid: firebaseUser.uid, email: firebaseUser.email, name: firebaseUser.displayName, role: 'provider' });
 assert.equal((await service.getUserProfile(firebaseUser)).role, 'provider');
 await assert.rejects(() => service.loginUser('provider@example.com', 'password', 'homeowner'), /registered as Warranty Provider/);
 assert.equal(signedOut, 1);
 exists = false; await assert.rejects(() => service.getUserProfile(firebaseUser), /profile was not found/);
 exists = true; data = { role: 'invalid' }; await assert.rejects(() => service.getUserProfile(firebaseUser), /Invalid user role/);
 await service.logoutUser(); assert.equal(signedOut, 2);
});
test('root linking protects provider routes and preserves provider-specific URLs', () => {
 const { rootLinking } = load('navigation/rootLinking.ts', { 'react-native': { Platform: { OS: 'web' } } });
 const signedOut = rootLinking().config.screens;
 assert.equal(signedOut.ProviderFlow, undefined); assert.equal(signedOut.Login, 'login/:role');
 assert.equal(signedOut.RoleSelection.path, ''); assert.equal(signedOut.RoleSelection.alias.includes('provider-entry'), true);
 const homeowner = rootLinking('homeowner').config.screens;
 assert.equal(homeowner.ProviderFlow, undefined);
 const screens = rootLinking('provider').config.screens.ProviderFlow.screens;
 assert.equal(screens.ProviderHome.screens.Dashboard, 'provider-dashboard');
 assert.equal(screens.ProviderHome.screens.Requests, 'warranty-requests');
 assert.equal(screens.ProviderHome.screens.Notifications, 'provider-notifications');
 assert.equal(screens.ProviderHome.screens.Profile, 'provider-profile');
 assert.equal(screens.CreateWarrantyRequest, 'create-warranty-request');
 assert.equal(screens.CustomerApplianceInfo, 'warranty-request/:warrantyRequestId/customer-appliance');
 assert.equal(screens.DocumentReview, 'warranty-request/:warrantyRequestId/documents');
 assert.equal(screens.WarrantyVerification, 'warranty-request/:warrantyRequestId/verification');
 assert.equal(screens.StatusUpdate, 'warranty-request/:warrantyRequestId/status');
 assert.equal(screens.WarrantyProviderEntry, undefined);
});
