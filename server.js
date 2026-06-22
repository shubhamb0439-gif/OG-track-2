const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const fs         = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path       = require('path');

let serviceAccount;
if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const app    = express();
const server = http.createServer(app);

// ── File upload setup ─────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter(req, file, cb) {
    cb(null, true); // allow all types
  }
});
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST','PATCH','DELETE'] } });
app.use(express.json());

// ── Cache-busting middleware for HTML ──────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Seed super admin ──────────────────────────────────────────────────────────
(async () => {
  const ref = db.collection('users').doc('sa1');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ id:'sa1', name:'Super Admin', email:'admin@bugtrack.com',
      password:'Admin@1234', role:'superadmin', status:'active',
      createdAt: new Date().toISOString() });
    console.log('Super admin seeded');
  }
})();

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const snap = await db.collection('users').get();
    res.json(snap.docs.map(d => { const u={...d.data()}; delete u.password; return u; }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const existing = await db.collection('users').where('email','==',email.toLowerCase()).get();
    if (!existing.empty) return res.status(400).json({ error: 'Email already registered.' });
    const user = { id:'u'+Date.now(), name, email:email.toLowerCase(), password, role, status:'pending', createdAt:new Date().toISOString() };
    await db.collection('users').doc(user.id).set(user);
    const safe = {...user}; delete safe.password;
    io.emit('user:registered', safe);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const snap = await db.collection('users').where('email','==',email.toLowerCase()).get();
    if (snap.empty) return res.status(401).json({ error: 'Incorrect email or password.' });
    const user = { id: snap.docs[0].id, ...snap.docs[0].data() };
    if (user.password !== password) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (user.status === 'pending')  return res.status(403).json({ error: 'Account pending Super Admin approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Account request was rejected.' });
    const safe = {...user}; delete safe.password;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id/status', async (req, res) => {
  try {
    await db.collection('users').doc(req.params.id).update({ status: req.body.status });
    const snap = await db.collection('users').doc(req.params.id).get();
    const user = { id: snap.id, ...snap.data() }; delete user.password;
    io.emit('user:updated', user);
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id/role', async (req, res) => {
  try {
    await db.collection('users').doc(req.params.id).update({ role: req.body.role });
    const snap = await db.collection('users').doc(req.params.id).get();
    const user = { id: snap.id, ...snap.data() }; delete user.password;
    io.emit('user:updated', user);
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    const snap = await db.collection('projects').orderBy('createdAt','desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const project = { ...req.body, createdAt: new Date().toISOString(), status: 'active' };
    if (project.shortCode) {
      const existing = await db.collection('projects').where('shortCode', '==', project.shortCode).get();
      if (!existing.empty) return res.status(400).json({ error: `Short code "${project.shortCode}" is already used by another project.` });
    }
    const ref = await db.collection('projects').add(project);
    const saved = { id: ref.id, ...project };
    io.emit('project:created', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/projects/:id', async (req, res) => {
  try {
    if (req.body.shortCode) {
      const existing = await db.collection('projects').where('shortCode', '==', req.body.shortCode).get();
      const conflict = existing.docs.find(d => d.id !== req.params.id);
      if (conflict) return res.status(400).json({ error: `Short code "${req.body.shortCode}" is already used by another project.` });
    }
    await db.collection('projects').doc(req.params.id).update(req.body);
    const snap = await db.collection('projects').doc(req.params.id).get();
    const saved = { id: snap.id, ...snap.data() };
    io.emit('project:updated', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await db.collection('projects').doc(req.params.id).delete();
    io.emit('project:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BUGS ──────────────────────────────────────────────────────────────────────
app.get('/api/bugs', async (req, res) => {
  try {
    const { projectId } = req.query;
    // Always fetch all bugs and sort/filter in memory to avoid composite index issues
    const snap = await db.collection('bugs').get();
    let bugs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (projectId) {
      // Match exact projectId OR legacy 'default' bugs that belong to this project
      bugs = bugs.filter(b => b.projectId === projectId || b.projectId === 'default');
    }
    bugs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(bugs);
  } catch(e) {
    console.error('GET /api/bugs error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bugs', async (req, res) => {
  try {
    const projectId = req.body.projectId || 'default';
    let shortCode = 'BUG';
    if (projectId !== 'default') {
      const projectDoc = await db.collection('projects').doc(projectId).get();
      if (projectDoc.exists && projectDoc.data().shortCode) {
        shortCode = projectDoc.data().shortCode;
      }
    }
    const counterRef = db.collection('meta').doc('counter_' + shortCode);
    const bugId = await db.runTransaction(async t => {
      const doc  = await t.get(counterRef);
      const next = doc.exists ? doc.data().count + 1 : 1;
      t.set(counterRef, { count: next });
      return shortCode + '-' + String(next).padStart(3,'0');
    });
    const silent = req.body._silent === true; // true for bulk imports
    delete req.body._silent;

    const status = req.body.status || 'Open';
    const bug = { ...req.body, id: bugId, status,
      createdAt: new Date().toISOString(), resolvedAt:null, retestedAt:null,
      fixSummary:'', furtherChanges:[],
      audit:[{ who:req.body.reporter, action: silent ? 'Bug imported from Excel' : 'Bug raised', when:new Date().toISOString(), note:'' }]
    };
    await db.collection('bugs').doc(bugId).set(bug);
    const pname = req.body.projectName ? `[${req.body.projectName}] ` : '';
    if (!silent) {
      const notif = { icon:'🐛', bugId, time:new Date().toISOString(), read:false,
        msg:`${pname}New bug: "${bug.title}" [${bugId}]` };
      io.emit('notification', { to:'developer', ...notif });
      io.emit('notification', { to:'manager',   ...notif, icon:'📋' });
    }
    io.emit('bug:created', bug);
    res.json(bug);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/bugs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    if ((updates.status === 'Resolved' || updates.status === 'Fixed') && !updates.resolvedAt) updates.resolvedAt = new Date().toISOString();
    if (updates._retested) { updates.retestedAt = new Date().toISOString(); delete updates._retested; }
    const src = updates._source; delete updates._source;
    const fc  = updates._furtherChange; delete updates._furtherChange;
    await db.collection('bugs').doc(id).update(updates);
    const snap = await db.collection('bugs').doc(id).get();
    const bug  = { id: snap.id, ...snap.data() };
    const base = { bugId: id, time: new Date().toISOString(), read: false };
    const pname = bug.projectName ? `[${bug.projectName}] ` : '';
    if (updates.status === 'Fixed') {
      io.emit('notification', { ...base, to:'tester',  icon:'✅', msg:`${pname}Bug ${id} fixed — please retest: "${bug.title}"` });
      io.emit('notification', { ...base, to:'manager', icon:'✅', msg:`${pname}"${bug.title}" marked fixed` });
    }
    if (updates.status === 'Open' && src === 'retest') {
      io.emit('notification', { ...base, to:'developer', icon:'🔄', msg:`${pname}Bug ${id} failed retest — reopened` });
      io.emit('notification', { ...base, to:'manager',   icon:'🔄', msg:`${pname}"${bug.title}" reopened` });
    }
    if (updates.status === 'Closed') {
      io.emit('notification', { ...base, to:'developer', icon:'🎉', msg:`${pname}Bug ${id} verified & closed` });
      io.emit('notification', { ...base, to:'manager',   icon:'🎉', msg:`${pname}"${bug.title}" closed` });
    }
    if (fc) {
      io.emit('notification', { ...base, to:'tester',  icon:'📝', msg:`${pname}Dev noted a change on ${id}: "${fc}"` });
      io.emit('notification', { ...base, to:'manager', icon:'📝', msg:`${pname}Further change on "${bug.title}"` });
    }
    io.emit('bug:updated', bug);
    res.json(bug);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bugs/:id', async (req, res) => {
  try {
    const bugId = req.params.id;
    const snap = await db.collection('bugs').doc(bugId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Not found' });
    const bug = { id: bugId, ...snap.data() };
    const silentDelete = req.query.silent === 'true';
    await db.collection('bugs').doc(bugId).delete();
    // Always broadcast deletion so it disappears from everyone's dashboard
    io.emit('bug:deleted', { id: bugId });
    // Only notify team if not a silent delete
    if (!silentDelete) {
      const pname = bug.projectName ? `[${bug.projectName}] ` : '';
      const msg = `${pname}${bug.id} "${bug.title}" deleted by ${bug.reporter}`;
      io.emit('notification', { icon:'🗑', time:new Date().toISOString(), read:false, to:'manager',   msg });
      io.emit('notification', { icon:'🗑', time:new Date().toISOString(), read:false, to:'developer', msg });
      io.emit('notification', { icon:'🗑', time:new Date().toISOString(), read:false, to:'tester',    msg });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MESSAGING ────────────────────────────────────────────────────────────────

// Get all conversations for a user
app.get('/api/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await db.collection('conversations')
      .where('memberIds', 'array-contains', userId)
      .get();
    const convos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    convos.sort((a, b) => new Date(b.lastMessageAt||0) - new Date(a.lastMessageAt||0));
    res.json(convos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create conversation (DM or group)
app.post('/api/conversations', async (req, res) => {
  try {
    const { name, memberIds, memberNames, type, createdBy } = req.body;

    // For DMs check if already exists
    if (type === 'dm' && memberIds.length === 2) {
      const snap = await db.collection('conversations')
        .where('type','==','dm')
        .where('memberIds','array-contains', memberIds[0])
        .get();
      const existing = snap.docs.find(d => {
        const m = d.data().memberIds;
        return m.includes(memberIds[1]) && m.length === 2;
      });
      if (existing) return res.json({ id: existing.id, ...existing.data() });
    }

    const convo = { name: name||'', type, memberIds, memberNames, createdBy,
      createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(),
      lastMessage: '', unreadCount: {} };
    memberIds.forEach(id => convo.unreadCount[id] = 0);
    const ref = await db.collection('conversations').add(convo);
    const saved = { id: ref.id, ...convo };
    // Notify all members
    memberIds.forEach(memberId => {
      io.emit(`conversation:new:${memberId}`, saved);
    });
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get messages for a conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const snap = await db.collection('conversations').doc(req.params.id)
      .collection('messages').orderBy('sentAt','asc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send message
app.post('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { senderId, senderName, text, replyTo } = req.body;
    const convoId = req.params.id;
    const msg = { senderId, senderName, text, sentAt: new Date().toISOString(), read: [], replyTo: replyTo||null };
    const ref = await db.collection('conversations').doc(convoId)
      .collection('messages').add(msg);
    const saved = { id: ref.id, ...msg };

    // Update conversation last message + unread counts
    const convoSnap = await db.collection('conversations').doc(convoId).get();
    const convo = convoSnap.data();
    const unreadCount = { ...convo.unreadCount };
    convo.memberIds.forEach(id => {
      if (id !== senderId) unreadCount[id] = (unreadCount[id]||0) + 1;
    });
    let previewText = text;
    if (text.startsWith('[img]')) previewText = '📷 Photo';
    else if (text.startsWith('[video]')) previewText = '🎬 Video';
    else if (text.match(/^\[file name=/)) previewText = '📎 File';
    await db.collection('conversations').doc(convoId).update({
      lastMessage: previewText.length > 60 ? previewText.slice(0,60)+'...' : previewText,
      lastMessageAt: new Date().toISOString(),
      unreadCount
    });

    // Emit to all members
    convo.memberIds.forEach(memberId => {
      io.emit(`message:new:${memberId}`, { convoId, message: saved });
    });
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark conversation as read
app.patch('/api/conversations/:id/read', async (req, res) => {
  try {
    const { userId } = req.body;
    const convoRef = db.collection('conversations').doc(req.params.id);
    const snap = await convoRef.get();
    const unreadCount = { ...snap.data().unreadCount, [userId]: 0 };
    await convoRef.update({ unreadCount });

    // Mark all unread messages as read by this user
    const msgsSnap = await convoRef.collection('messages')
      .where('senderId', '!=', userId).get();
    const batch = db.batch();
    msgsSnap.docs.forEach(doc => {
      const readArr = doc.data().read || [];
      if (!readArr.includes(userId)) {
        batch.update(doc.ref, { read: [...readArr, userId] });
      }
    });
    await batch.commit();

    // Notify senders their messages were seen
    const convoData = snap.data();
    convoData.memberIds.forEach(memberId => {
      if (memberId !== userId) {
        io.emit(`seen:${memberId}`, { convoId: req.params.id, seenBy: userId });
      }
    });

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── File Upload ──────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname) || '';
    const newName = req.file.filename + ext;
    const newPath = path.join(UPLOAD_DIR, newName);
    fs.renameSync(req.file.path, newPath);
    const url = '/uploads/' + newName;
    res.json({ url, name: req.file.originalname, type: req.file.mimetype, size: req.file.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ATTENDANCE ───────────────────────────────────────────────────────────────

app.post('/api/attendance/clockin', async (req, res) => {
  try {
    const { userId, userName } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('attendance').doc(`${userId}_${today}`);
    const snap = await ref.get();
    if (snap.exists && snap.data().clockIn) return res.status(400).json({ error: 'Already clocked in today' });
    const now = new Date().toISOString();
    await ref.set({ userId, userName, date: today, clockIn: now, clockOut: null, totalHours: null, status: 'present' }, { merge: true });
    io.emit(`attendance:${userId}`, { date: today, clockIn: now });
    res.json({ success: true, clockIn: now });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attendance/clockout', async (req, res) => {
  try {
    const { userId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('attendance').doc(`${userId}_${today}`);
    const snap = await ref.get();
    if (!snap.exists || !snap.data().clockIn) return res.status(400).json({ error: 'Not clocked in today' });
    if (snap.data().clockOut) return res.status(400).json({ error: 'Already clocked out' });
    const now = new Date().toISOString();
    const hrs = ((new Date(now) - new Date(snap.data().clockIn)) / 3600000).toFixed(2);
    await ref.update({ clockOut: now, totalHours: parseFloat(hrs) });
    io.emit(`attendance:${userId}`, { date: today, clockOut: now, totalHours: hrs });
    res.json({ success: true, clockOut: now, totalHours: hrs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attendance/today/:userId', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection('attendance').doc(`${req.params.userId}_${today}`).get();
    res.json(snap.exists ? snap.data() : null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attendance/user/:userId', async (req, res) => {
  try {
    // Simple equality query only — no composite index needed; sort in memory
    const snap = await db.collection('attendance').where('userId','==',req.params.userId).get();
    const data = snap.docs.map(d => d.data()).sort((a,b) => b.date.localeCompare(a.date)).slice(0,60);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attendance/all', async (req, res) => {
  try {
    // Single-field orderBy — Firestore auto-creates this index
    const snap = await db.collection('attendance').get();
    const data = snap.docs.map(d => d.data()).sort((a,b) => b.date.localeCompare(a.date)).slice(0,300);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attendance/regularize', async (req, res) => {
  try {
    const { userId, userName, date, reason, requestedIn, requestedOut } = req.body;
    const ref = db.collection('regularizeRequests').doc();
    const data = { id: ref.id, userId, userName, date, reason, requestedIn, requestedOut, status: 'pending', createdAt: new Date().toISOString() };
    await ref.set(data);
    io.emit('regularize:new', data);
    res.json({ success: true, id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attendance/regularize', async (req, res) => {
  try {
    const { userId } = req.query;
    const snap = await db.collection('regularizeRequests').get();
    let data = snap.docs.map(d => d.data()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    if (userId) data = data.filter(r => r.userId === userId);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/attendance/regularize/:id', async (req, res) => {
  try {
    const { status, approvedBy } = req.body;
    const ref = db.collection('regularizeRequests').doc(req.params.id);
    await ref.update({ status, approvedBy, resolvedAt: new Date().toISOString() });
    if (status === 'approved') {
      const snap = await ref.get(); const r = snap.data();
      const attRef = db.collection('attendance').doc(`${r.userId}_${r.date}`);
      const update = { userId: r.userId, userName: r.userName, date: r.date, clockIn: r.requestedIn, clockOut: r.requestedOut, status: 'regularized' };
      if (r.requestedIn && r.requestedOut) update.totalHours = parseFloat(((new Date(r.requestedOut) - new Date(r.requestedIn)) / 3600000).toFixed(2));
      await attRef.set(update, { merge: true });
    }
    io.emit('regularize:updated', { id: req.params.id, status });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LEAVE REQUESTS ────────────────────────────────────────────────────────────

app.post('/api/leave', async (req, res) => {
  try {
    const { userId, userName, from, to, reason, leaveType } = req.body;
    const ref = db.collection('leaveRequests').doc();
    const data = { id: ref.id, userId, userName, from, to, reason, leaveType: leaveType||'Casual', status: 'pending', createdAt: new Date().toISOString() };
    await ref.set(data);
    io.emit('leave:new', data);
    res.json({ success: true, id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leave', async (req, res) => {
  try {
    const { userId } = req.query;
    const snap = await db.collection('leaveRequests').get();
    let data = snap.docs.map(d => d.data()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    if (userId) data = data.filter(r => r.userId === userId);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leave/:id', async (req, res) => {
  try {
    const { status, approvedBy } = req.body;
    await db.collection('leaveRequests').doc(req.params.id).update({ status, approvedBy, resolvedAt: new Date().toISOString() });
    io.emit('leave:updated', { id: req.params.id, status });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CUSTOM ROLES ──────────────────────────────────────────────────────────────

app.get('/api/roles', async (req, res) => {
  try {
    const snap = await db.collection('customRoles').orderBy('createdAt','desc').get();
    res.json(snap.docs.map(d => d.data()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/roles', async (req, res) => {
  try {
    const { name, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const ref = db.collection('customRoles').doc();
    const data = { id: ref.id, name, permissions: permissions||[], createdAt: new Date().toISOString() };
    await ref.set(data);
    io.emit('role:created', data);
    res.json({ success: true, ...data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/roles/:id', async (req, res) => {
  try {
    const { name, permissions } = req.body;
    await db.collection('customRoles').doc(req.params.id).update({ name, permissions });
    io.emit('role:updated', { id: req.params.id, name, permissions });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/roles/:id', async (req, res) => {
  try {
    await db.collection('customRoles').doc(req.params.id).delete();
    io.emit('role:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // Typing indicators
  socket.on('typing:start', ({ convoId, userName, memberIds }) => {
    memberIds.forEach(id => io.emit(`typing:${convoId}:${id}`, { userName, typing: true }));
  });
  socket.on('typing:stop', ({ convoId, memberIds }) => {
    memberIds.forEach(id => io.emit(`typing:${convoId}:${id}`, { typing: false }));
  });

  socket.on('disconnect', () => console.log('Disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BugTrack running on port ${PORT}`));