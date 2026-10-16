/* Seed accounts – loaded by every device that opens this site, so the sign-in page always has users.
   Default super admin:  admin@tracker.com      /  Admin@1234   (change the password after first sign-in)
   Admin (test):         testadmin@gmail.com  /  testpass
   To publish account changes: sign in as super admin → Users → "Download users.js" → replace this file in the repository. */
window.SEED_USERS=[
 {email:'admin@tracker.com',name:'Super admin',role:'superadmin',pw:'4d8530928d12550ad56a62988ced854b1f5c532f50ee1a8c3627777569cf766e',at:'2026-10-13',by:'seed'},
 {email:'testadmin@gmail.com',name:'test admin',role:'admin',pw:'7873fc1bfdb6497df53c3f04f1fd529274aa654fa598d8f24d57c1bc153c27e1',at:'2026-10-13',by:'seed'}
];
