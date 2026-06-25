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
const CLOSED_STATUSES = new Set(['Resolved','Fixed','Closed',"Won't Fix",'Wont Fix','Not a Bug','Expected Behavior','NAB']);
app.get('/api/bugs/counts', async (req, res) => {
  try {
    const snap = await db.collection('bugs').select('projectId','status').get();
    const counts = {};
    snap.docs.forEach(d => {
      const { projectId: pid, status } = d.data();
      if (!pid) return;
      if (!counts[pid]) counts[pid] = { total: 0, open: 0 };
      counts[pid].total++;
      if (!CLOSED_STATUSES.has(status)) counts[pid].open++;
    });
    res.json(counts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// ── CLIENTS ──────────────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const snap = await db.collection('clients').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients', async (req, res) => {
  try {
    const client = { ...req.body, createdAt: new Date().toISOString(), status: 'active' };
    const ref = await db.collection('clients').add(client);
    const saved = { id: ref.id, ...client };
    io.emit('client:created', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/clients/:id', async (req, res) => {
  try {
    await db.collection('clients').doc(req.params.id).update(req.body);
    const snap = await db.collection('clients').doc(req.params.id).get();
    const saved = { id: snap.id, ...snap.data() };
    io.emit('client:updated', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/clients/:id', async (req, res) => {
  try {
    await db.collection('clients').doc(req.params.id).delete();
    io.emit('client:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIME ENTRIES ──────────────────────────────────────────────────────────────
app.get('/api/time-entries', async (req, res) => {
  try {
    const snap = await db.collection('timeEntries').get();
    let entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { accountantId, date } = req.query;
    if (accountantId) entries = entries.filter(e => e.accountantId === accountantId);
    if (date) entries = entries.filter(e => e.date === date);
    res.json(entries);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/time-entries', async (req, res) => {
  try {
    const entry = { ...req.body, createdAt: new Date().toISOString() };
    const ref = await db.collection('timeEntries').add(entry);
    const saved = { id: ref.id, ...entry };
    io.emit('timeEntry:created', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/time-entries/:id', async (req, res) => {
  try {
    await db.collection('timeEntries').doc(req.params.id).update(req.body);
    const snap = await db.collection('timeEntries').doc(req.params.id).get();
    const saved = { id: snap.id, ...snap.data() };
    io.emit('timeEntry:updated', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EOD REPORTS ───────────────────────────────────────────────────────────────
app.get('/api/eod-reports', async (req, res) => {
  try {
    const snap = await db.collection('eodReports').get();
    let reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { accountantId, date, status } = req.query;
    if (accountantId) reports = reports.filter(r => r.accountantId === accountantId);
    if (date) reports = reports.filter(r => r.date === date);
    if (status) reports = reports.filter(r => r.status === status);
    res.json(reports);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/eod-reports', async (req, res) => {
  try {
    const report = { ...req.body, createdAt: new Date().toISOString() };
    const ref = await db.collection('eodReports').add(report);
    const saved = { id: ref.id, ...report };
    io.emit('eodReport:submitted', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/eod-reports/:id', async (req, res) => {
  try {
    await db.collection('eodReports').doc(req.params.id).update(req.body);
    const snap = await db.collection('eodReports').doc(req.params.id).get();
    const saved = { id: snap.id, ...snap.data() };
    io.emit('eodReport:updated', saved);
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Sprints ───────────────────────────────────────────────────────────────────
app.get('/api/sprints', async (req, res) => {
  try {
    const { projectId } = req.query;
    let q = db.collection('sprints');
    if (projectId) q = q.where('projectId', '==', projectId);
    const snap = await q.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sprints', async (req, res) => {
  try {
    const data = { ...req.body, createdAt: new Date().toISOString() };
    const ref = await db.collection('sprints').add(data);
    res.json({ id: ref.id, ...data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/sprints/:id', async (req, res) => {
  try {
    await db.collection('sprints').doc(req.params.id).update({ ...req.body, updatedAt: new Date().toISOString() });
    const doc = await db.collection('sprints').doc(req.params.id).get();
    res.json({ id: doc.id, ...doc.data() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/sprints/:id', async (req, res) => {
  try {
    await db.collection('sprints').doc(req.params.id).delete();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stories ───────────────────────────────────────────────────────────────────
app.get('/api/stories', async (req, res) => {
  try {
    const { projectId } = req.query;
    let q = db.collection('stories');
    if (projectId) q = q.where('projectId', '==', projectId);
    const snap = await q.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stories', async (req, res) => {
  try {
    const { projectId } = req.body;
    let shortCode = 'ST';
    if (projectId) {
      const pDoc = await db.collection('projects').doc(projectId).get();
      if (pDoc.exists && pDoc.data().shortCode) shortCode = pDoc.data().shortCode;
    }
    const counterRef = db.collection('meta').doc('story_counter_' + shortCode);
    const storyId = await db.runTransaction(async t => {
      const doc = await t.get(counterRef);
      const next = doc.exists ? doc.data().count + 1 : 1;
      t.set(counterRef, { count: next });
      return shortCode + '-S' + String(next).padStart(3, '0');
    });
    const data = { ...req.body, storyId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const ref = await db.collection('stories').add(data);
    res.json({ id: ref.id, ...data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/stories/:id', async (req, res) => {
  try {
    await db.collection('stories').doc(req.params.id).update({ ...req.body, updatedAt: new Date().toISOString() });
    const doc = await db.collection('stories').doc(req.params.id).get();
    res.json({ id: doc.id, ...doc.data() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/stories/:id', async (req, res) => {
  try {
    await db.collection('stories').doc(req.params.id).delete();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Subscription Tickets ─────────────────────────────────────────────────────
app.get('/api/sub-tickets', async (req, res) => {
  try {
    const { userId, role } = req.query;
    const snap = await db.collection('sub_tickets').orderBy('createdAt', 'desc').get();
    let tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const viewAll = ['superadmin','manager','accounts_manager','senior_accountant'].includes(role);
    if (!viewAll && userId) tickets = tickets.filter(t => t.raisedById === userId);
    res.json(tickets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sub-tickets', async (req, res) => {
  try {
    const counterRef = db.collection('meta').doc('sub_ticket_counter');
    const ticketId = await db.runTransaction(async t => {
      const doc = await t.get(counterRef);
      const next = doc.exists ? doc.data().count + 1 : 1;
      t.set(counterRef, { count: next });
      return 'REQ-' + String(next).padStart(3, '0');
    });
    const data = { ...req.body, ticketId, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const ref = await db.collection('sub_tickets').add(data);
    res.json({ id: ref.id, ...data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/sub-tickets/:id', async (req, res) => {
  try {
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    await db.collection('sub_tickets').doc(req.params.id).update(updates);
    const doc = await db.collection('sub_tickets').doc(req.params.id).get();
    res.json({ id: doc.id, ...doc.data() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sub-tickets/:id', async (req, res) => {
  try {
    await db.collection('sub_tickets').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HR: AI Candidate Analysis ─────────────────────────────────────────────────
function analyzeCandidate(candidate, job) {
  const text = [candidate.coverLetter||'', candidate.skills||'', candidate.experienceSummary||'', candidate.education||''].join(' ').toLowerCase();
  const requiredSkills = Array.isArray(job.skills) ? job.skills : (job.skills||'').split(',').map(s=>s.trim()).filter(Boolean);
  const matchedSkills = requiredSkills.filter(s => text.includes(s.toLowerCase()));
  const missingSkills = requiredSkills.filter(s => !text.includes(s.toLowerCase()));
  const skillScore = requiredSkills.length > 0 ? Math.round((matchedSkills.length / requiredSkills.length) * 40) : 20;
  const reqExpStr = (job.experience||'').replace(/[^\d.]/g,' ').trim().split(/\s+/)[0];
  const reqExp = parseFloat(reqExpStr)||0;
  const candExp = parseFloat(candidate.experienceYears)||0;
  let expScore = 0;
  if(candExp >= reqExp) expScore = 30;
  else if(reqExp>0 && candExp >= reqExp*0.7) expScore = 20;
  else if(reqExp>0 && candExp >= reqExp*0.5) expScore = 12;
  else if(candExp > 0) expScore = 8;
  const qualReq = (job.qualification||'').toLowerCase();
  let eduScore = 8;
  if(qualReq.includes('phd')||qualReq.includes('doctor')) {
    if(text.includes('phd')||text.includes('doctor')) eduScore=15; else if(text.includes('master')||text.includes('mba')) eduScore=10; else eduScore=5;
  } else if(qualReq.includes('master')||qualReq.includes('mba')) {
    if(text.includes('master')||text.includes('mba')) eduScore=15; else if(text.includes('bachelor')||text.includes('b.tech')||text.includes('b.e.')) eduScore=10;
  } else {
    if(text.includes('master')||text.includes('mba')||text.includes('phd')) eduScore=15;
    else if(text.includes('bachelor')||text.includes('b.tech')||text.includes('b.e.')||text.includes('bsc')) eduScore=12;
  }
  const jdText=(job.description||'').toLowerCase();
  const jdWords=jdText.split(/\W+/).filter(w=>w.length>4);
  const jdSet=new Set(jdWords);
  const textWords=text.split(/\W+/).filter(w=>w.length>4);
  const jdMatchCount=textWords.filter(w=>jdSet.has(w)).length;
  const jdScore=Math.min(15, jdWords.length>0 ? Math.round((jdMatchCount/jdWords.length)*100) : 10);
  const totalScore=Math.min(100, skillScore+expScore+eduScore+jdScore);
  let priority='Low'; if(totalScore>=80) priority='High'; else if(totalScore>=60) priority='Medium';
  return {
    score:totalScore, skillScore, expScore, eduScore, jdScore,
    matchedSkills, missingSkills,
    experienceMatch: candExp>=reqExp ? 'Meets requirement' : `${candExp}yr (${reqExp}+ required)`,
    priority,
    recommendation: totalScore>=80?'Strongly recommended':totalScore>=60?'Recommended for HR review':totalScore>=40?'Consider with screening':'Below minimum requirements',
    analyzedAt: new Date().toISOString()
  };
}

// ── HR: Jobs ──────────────────────────────────────────────────────────────────
app.get('/api/jobs', async (req, res) => {
  try {
    const snap = await db.collection('jobs').orderBy('createdAt','desc').get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/jobs/public', async (req, res) => {
  try {
    const snap = await db.collection('jobs').where('status','==','published').get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/jobs', async (req, res) => {
  try {
    const snap = await db.collection('jobs').get();
    const jobId = 'JOB-'+String(snap.size+1).padStart(3,'0');
    const data = {...req.body, jobId, applications:0, createdAt:new Date().toISOString()};
    const ref = await db.collection('jobs').add(data);
    res.json({id:ref.id,...data});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/jobs/:id', async (req, res) => {
  try {
    await db.collection('jobs').doc(req.params.id).update({...req.body, updatedAt:new Date().toISOString()});
    const doc = await db.collection('jobs').doc(req.params.id).get();
    res.json({id:doc.id,...doc.data()});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    await db.collection('jobs').doc(req.params.id).delete();
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── HR: Candidates ────────────────────────────────────────────────────────────
app.get('/api/candidates', async (req, res) => {
  try {
    let snap;
    if(req.query.jobId) snap = await db.collection('candidates').where('jobId','==',req.query.jobId).get();
    else snap = await db.collection('candidates').orderBy('appliedAt','desc').get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/candidates/:id', async (req, res) => {
  try {
    const doc = await db.collection('candidates').doc(req.params.id).get();
    if(!doc.exists) return res.status(404).json({error:'Not found'});
    res.json({id:doc.id,...doc.data()});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/candidates', async (req, res) => {
  try {
    const snap = await db.collection('candidates').get();
    const candidateId = 'CAND-'+String(snap.size+1).padStart(4,'0');
    const now = new Date().toISOString();
    const data = {
      ...req.body, candidateId, status:'applied', appliedAt:now, aiScore:null, aiAnalysis:null,
      statusHistory:[{status:'applied',timestamp:now,by:'Candidate'}]
    };
    if(data.jobId){
      const jobRef = db.collection('jobs').doc(data.jobId);
      const job = await jobRef.get();
      if(job.exists) await jobRef.update({applications:(job.data().applications||0)+1});
    }
    const ref = await db.collection('candidates').add(data);
    // Auto AI analysis
    if(data.jobId){
      try {
        const job = await db.collection('jobs').doc(data.jobId).get();
        if(job.exists){
          const analysis = analyzeCandidate(data,job.data());
          const newStatus = analysis.score>=60?'shortlisted':'ai_screened';
          await ref.update({aiScore:analysis.score,aiAnalysis:analysis,status:newStatus,
            statusHistory:[...data.statusHistory,{status:'ai_screened',timestamp:new Date().toISOString(),by:'AI System'}]});
        }
      } catch(ae){}
    }
    const saved = await ref.get();
    res.json({id:ref.id,...saved.data()});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/candidates/:id', async (req, res) => {
  try {
    const doc = await db.collection('candidates').doc(req.params.id).get();
    const current = doc.data();
    const updates = {...req.body, updatedAt:new Date().toISOString()};
    if(req.body.status && req.body.status !== current.status){
      updates.statusHistory = [...(current.statusHistory||[]),{status:req.body.status,timestamp:new Date().toISOString(),by:req.body.changedBy||'HR'}];
    }
    delete updates.changedBy;
    await db.collection('candidates').doc(req.params.id).update(updates);
    const updated = await db.collection('candidates').doc(req.params.id).get();
    res.json({id:updated.id,...updated.data()});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/candidates/:id', async (req, res) => {
  try {
    await db.collection('candidates').doc(req.params.id).delete();
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/candidates/:id/analyze', async (req, res) => {
  try {
    const doc = await db.collection('candidates').doc(req.params.id).get();
    if(!doc.exists) return res.status(404).json({error:'Not found'});
    const candidate = doc.data();
    if(!candidate.jobId) return res.status(400).json({error:'No job linked'});
    const job = await db.collection('jobs').doc(candidate.jobId).get();
    if(!job.exists) return res.status(404).json({error:'Job not found'});
    const analysis = analyzeCandidate(candidate, job.data());
    await db.collection('candidates').doc(req.params.id).update({aiScore:analysis.score,aiAnalysis:analysis});
    res.json({id:req.params.id,aiScore:analysis.score,aiAnalysis:analysis});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── HR: Interviews ────────────────────────────────────────────────────────────
app.get('/api/interviews', async (req, res) => {
  try {
    let snap;
    if(req.query.candidateId) snap=await db.collection('interviews').where('candidateId','==',req.query.candidateId).get();
    else snap=await db.collection('interviews').orderBy('scheduledAt','desc').get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/interviews', async (req, res) => {
  try {
    const snap = await db.collection('interviews').get();
    const interviewId = 'INT-'+String(snap.size+1).padStart(4,'0');
    const data = {...req.body, interviewId, status:'scheduled', createdAt:new Date().toISOString()};
    const ref = await db.collection('interviews').add(data);
    if(data.candidateId){
      const cand = await db.collection('candidates').doc(data.candidateId).get();
      if(cand.exists){
        const cd=cand.data();
        await db.collection('candidates').doc(data.candidateId).update({
          status:'interview_scheduled',
          statusHistory:[...(cd.statusHistory||[]),{status:'interview_scheduled',timestamp:new Date().toISOString(),by:data.scheduledBy||'HR'}]
        });
      }
    }
    res.json({id:ref.id,...data});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/interviews/:id', async (req, res) => {
  try {
    await db.collection('interviews').doc(req.params.id).update({...req.body,updatedAt:new Date().toISOString()});
    const doc = await db.collection('interviews').doc(req.params.id).get();
    res.json({id:doc.id,...doc.data()});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/interviews/:id', async (req, res) => {
  try {
    await db.collection('interviews').doc(req.params.id).delete();
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Career Page ───────────────────────────────────────────────────────────────
app.get('/careers', async (req, res) => {
  try {
    const snap = await db.collection('jobs').where('status','==','published').get();
    const jobs = snap.docs.map(d=>({id:d.id,...d.data()}));
    res.send(buildCareersHTML(jobs));
  } catch(e){ res.status(500).send('<h2>Error loading careers page</h2>'); }
});

app.get('/careers/:jobId', async (req, res) => {
  try {
    const doc = await db.collection('jobs').doc(req.params.jobId).get();
    if(!doc.exists||doc.data().status!=='published') return res.redirect('/careers');
    res.send(buildJobDetailHTML({id:doc.id,...doc.data()}));
  } catch(e){ res.redirect('/careers'); }
});

function buildCareersHTML(jobs) {
  const cards = jobs.length ? jobs.map(j=>`
    <div class="jc"><div class="jc-vac">📌 ${j.vacancies||1} opening${(j.vacancies||1)>1?'s':''}</div>
    <div class="jc-title">${j.title}</div>
    <div class="jc-meta"><span class="tag">${j.department}</span><span class="tag">${j.employmentType}</span><span class="tag">📍 ${j.location}</span><span class="tag">💻 ${j.workMode}</span>${j.experience?`<span class="tag">🏆 ${j.experience}</span>`:''}</div>
    <div class="jc-desc">${(j.description||'').substring(0,200)}${(j.description||'').length>200?'...':''}</div>
    <a href="/careers/${j.id}" class="abtn">View & Apply →</a></div>`).join('')
    : '<div class="empty"><h3>No open positions</h3><p>Check back soon!</p></div>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Careers — OGPlus</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#1a1a1a}
.hdr{background:#C0392B;color:#fff;padding:48px 20px;text-align:center}.hdr h1{font-size:32px;font-weight:800;margin-bottom:8px}.hdr p{opacity:.85}
.wrap{max-width:900px;margin:32px auto;padding:0 16px}.jc{background:#fff;border-radius:12px;padding:24px;margin-bottom:14px;border:1px solid #e0e0e0;transition:box-shadow .15s}.jc:hover{box-shadow:0 4px 20px rgba(0,0,0,.1)}
.jc-vac{font-size:12px;color:#27AE60;font-weight:600;margin-bottom:4px}.jc-title{font-size:18px;font-weight:700;margin-bottom:8px}
.jc-meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.tag{background:#f0f0f0;color:#666;padding:3px 10px;border-radius:20px;font-size:12px}
.jc-desc{font-size:13px;color:#666;line-height:1.6;margin-bottom:14px}.abtn{background:#C0392B;color:#fff;padding:10px 20px;border-radius:8px;border:none;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
.abtn:hover{background:#a93226}.empty{text-align:center;padding:60px 20px;color:#999}</style></head>
<body><div class="hdr"><h1>Join Our Team</h1><p>Explore exciting career opportunities</p></div>
<div class="wrap">${cards}</div></body></html>`;
}

function buildJobDetailHTML(job) {
  const skills = Array.isArray(job.skills)?job.skills:(job.skills||'').split(',').map(s=>s.trim()).filter(Boolean);
  const skillTags = skills.map(s=>`<span style="background:#e8f4fd;color:#2980b9;padding:3px 10px;border-radius:20px;font-size:12px;margin:3px 2px;display:inline-block">${s}</span>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${job.title} — Careers</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#1a1a1a}
.hdr{background:#C0392B;color:#fff;padding:28px 20px}.hdr a{color:rgba(255,255,255,.75);font-size:13px;text-decoration:none;display:block;margin-bottom:8px}.hdr h1{font-size:24px;font-weight:800;margin-bottom:8px}
.wrap{max-width:820px;margin:28px auto;padding:0 16px;display:grid;grid-template-columns:1fr 300px;gap:18px}@media(max-width:650px){.wrap{grid-template-columns:1fr}}
.card{background:#fff;border-radius:12px;padding:22px;border:1px solid #e0e0e0;margin-bottom:14px}h2{font-size:17px;font-weight:700;margin-bottom:12px}
.desc{font-size:13px;line-height:1.75;color:#555;white-space:pre-line}.mr{display:flex;align-items:center;gap:8px;font-size:13px;color:#555;margin-bottom:8px}
label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:4px;margin-top:10px}
input,textarea,select{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:7px;font-size:13px;outline:none;font-family:inherit}
input:focus,textarea:focus{border-color:#C0392B}textarea{min-height:80px;resize:vertical}
.sbtn{width:100%;background:#C0392B;color:#fff;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;margin-top:14px}
.sbtn:hover{background:#a93226}.sbtn:disabled{opacity:.6;cursor:not-allowed}
.ok{background:#e8f5e9;color:#2e7d32;padding:16px;border-radius:8px;text-align:center;display:none;font-weight:600}</style></head>
<body>
<div class="hdr"><a href="/careers">← All Openings</a><h1>${job.title}</h1>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
<span style="background:rgba(255,255,255,.2);padding:2px 10px;border-radius:12px;font-size:12px">${job.department}</span>
<span style="background:rgba(255,255,255,.2);padding:2px 10px;border-radius:12px;font-size:12px">${job.employmentType}</span>
<span style="background:rgba(255,255,255,.2);padding:2px 10px;border-radius:12px;font-size:12px">📍 ${job.location}</span></div></div>
<div class="wrap">
<div>
  <div class="card"><h2>About the Role</h2><div class="desc">${job.description||'No description provided.'}</div></div>
  ${job.responsibilities?`<div class="card"><h2>Responsibilities</h2><div class="desc">${job.responsibilities}</div></div>`:''}
  ${skills.length?`<div class="card"><h2>Required Skills</h2><div style="margin-top:6px">${skillTags}</div></div>`:''}
  ${job.qualification?`<div class="card"><h2>Qualification</h2><p style="font-size:13px;color:#555">${job.qualification}</p></div>`:''}
</div>
<div>
<div class="card">
<div style="margin-bottom:18px">
  <div class="mr">📌 ${job.vacancies||1} opening${(job.vacancies||1)>1?'s':''}</div>
  <div class="mr">💰 ${job.salaryRange||'Competitive'}</div>
  <div class="mr">🏆 ${job.experience||'Any'} experience</div>
  <div class="mr">💻 ${job.workMode||'Office'}</div>
  ${job.lastDate?`<div class="mr">📅 Apply by ${job.lastDate}</div>`:''}
</div>
<div id="ok" class="ok">✅ Application submitted! We'll review your profile shortly.</div>
<form id="af" onsubmit="submit(event,'${job.id}','${job.title}')">
<h2>Apply Now</h2>
<label>Full Name *</label><input id="cn" required placeholder="Your name">
<label>Email *</label><input type="email" id="ce" required placeholder="you@example.com">
<label>Phone *</label><input type="tel" id="cp" required placeholder="+91 XXXXX XXXXX">
<label>Current Location *</label><input id="cl" required placeholder="City, State">
<label>Years of Experience *</label><input type="number" id="cexp" required min="0" max="50" step="0.5" placeholder="3.5">
<label>Education</label><input id="cedu" placeholder="B.Tech Computer Science">
<label>Skills (comma-separated)</label><input id="csk" placeholder="React, Node.js, MongoDB">
<label>Expected Salary</label><input id="csal" placeholder="₹12L per annum">
<label>LinkedIn / Portfolio</label><input type="url" id="cpf" placeholder="https://linkedin.com/in/...">
<label>Cover Letter / About You *</label><textarea id="ccv" required placeholder="Tell us about yourself..."></textarea>
<label>Resume (PDF/DOC)</label><input type="file" id="cres" accept=".pdf,.doc,.docx">
<button type="submit" class="sbtn" id="sb">Submit Application →</button>
</form>
</div></div></div>
<script>
async function submit(e,jobId,jobTitle){
  e.preventDefault();
  const btn=document.getElementById('sb'); btn.textContent='Submitting...'; btn.disabled=true;
  let resumeUrl='';
  const file=document.getElementById('cres').files[0];
  if(file){try{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/upload',{method:'POST',body:fd});const d=await r.json();resumeUrl=d.url||'';}catch(err){}}
  const data={jobId,jobTitle,name:document.getElementById('cn').value.trim(),email:document.getElementById('ce').value.trim(),
    phone:document.getElementById('cp').value.trim(),currentLocation:document.getElementById('cl').value.trim(),
    experienceYears:parseFloat(document.getElementById('cexp').value)||0,education:document.getElementById('cedu').value.trim(),
    skills:document.getElementById('csk').value.trim(),expectedSalary:document.getElementById('csal').value.trim(),
    portfolio:document.getElementById('cpf').value.trim(),coverLetter:document.getElementById('ccv').value.trim(),
    resumeUrl,source:'Career Page'};
  try{
    await fetch('/api/candidates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    document.getElementById('af').style.display='none'; document.getElementById('ok').style.display='block';
  }catch(err){btn.textContent='Submit Application →';btn.disabled=false;alert('Failed to submit. Try again.');}
}
</script></body></html>`;
}

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