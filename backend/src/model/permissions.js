'use strict';
/* permissions.js – the single source of truth for what each role may do.
   The browser hides buttons using the same rules, but THIS file is what actually enforces them:
   every write goes through `assert()` below, so a blocked role cannot change data by calling the
   API directly.

   superadmin : everything, plus creating users and assigning roles
   admin      : create / edit / delete / export every kind of item
   superuser  : view everything; create / edit / delete TASKS only; export (PDF, Excel, print)
   viewer     : view only                                                                      */

const ROLES = ['superadmin', 'admin', 'superuser', 'viewer'];

const ROLE_LABEL = {
  superadmin: 'Super admin',
  admin: 'Admin',
  superuser: 'Superuser',
  viewer: 'Viewer',
};

const ROLE_DESCRIPTION = {
  superadmin: 'Full access, plus user and role management',
  admin: 'Create, edit, delete and export everything',
  superuser: 'View everything · create and edit Tasks · export',
  viewer: 'View only',
};

/* Item types, using the stored values. 'Drive' is shown as "Recurring" in the interface. */
const TYPES = ['Project', 'Drive', 'Task'];

/* Which item types each role may create, edit, delete and change the status of. */
const WRITABLE_TYPES = {
  superadmin: ['Project', 'Drive', 'Task'],
  admin: ['Project', 'Drive', 'Task'],
  superuser: ['Task'],
  viewer: [],
};

const CAPABILITIES = {
  superadmin: { view: true, export: true, manageUsers: true, viewAudit: true },
  admin: { view: true, export: true, manageUsers: false, viewAudit: false },
  superuser: { view: true, export: true, manageUsers: false, viewAudit: false },
  viewer: { view: true, export: false, manageUsers: false, viewAudit: false },
};

const isRole = r => ROLES.includes(r);

/** Can this role perform `action`? For 'write', pass the item type as `type`. */
function can(role, action, type) {
  if (!isRole(role)) return false;
  if (action === 'write') return WRITABLE_TYPES[role].includes(type);
  const caps = CAPABILITIES[role];
  return Boolean(caps && caps[action]);
}

/** A ready-made description of a role, sent to the browser after signing in. */
function describe(role) {
  return {
    role,
    label: ROLE_LABEL[role] || role,
    description: ROLE_DESCRIPTION[role] || '',
    writableTypes: WRITABLE_TYPES[role] || [],
    ...CAPABILITIES[role],
  };
}

/** Throws a 403 unless the role is allowed. Used by every route that changes data. */
function assert(role, action, type) {
  if (can(role, action, type)) return true;
  const label = ROLE_LABEL[role] || role || 'Signed out';
  const what =
    action === 'write' ? `edit ${type === 'Drive' ? 'Recurring items' : (type || 'item') + 's'}`
    : action === 'export' ? 'download or print'
    : action === 'manageUsers' ? 'manage users'
    : action === 'viewAudit' ? 'read the audit log'
    : action;
  const err = new Error(`Your role (${label}) cannot ${what}`);
  err.status = 403;
  err.code = 'forbidden';
  throw err;
}

module.exports = {
  ROLES, ROLE_LABEL, ROLE_DESCRIPTION, TYPES, WRITABLE_TYPES, CAPABILITIES,
  isRole, can, describe, assert,
};
