# BugTrack — Setup & Deployment Guide

---

## What you have

```
bugtracker/
├── server.js               ← Backend (Node.js + Socket.io)
├── package.json            ← Dependencies list
├── serviceAccountKey.json  ← Firebase credentials (you fill this in)
└── public/
    └── index.html          ← Frontend (the app everyone opens)
```

---

## Step 1 — Install Node.js (one time only)

1. Go to **https://nodejs.org**
2. Download the **LTS** version (the green button)
3. Run the installer — click Next through everything
4. To verify it worked, open **Terminal** (Mac) or **Command Prompt** (Windows) and type:
   ```
   node --version
   ```
   You should see something like `v20.11.0`

---

## Step 2 — Set up Firebase (free, takes ~5 minutes)

Firebase stores all your bugs so everyone on the team sees the same data in real time.

### 2a. Create a Firebase project
1. Go to **https://console.firebase.google.com**
2. Click **"Add project"**
3. Give it a name like `bugtracker` → click through the setup steps
4. When asked about Google Analytics, you can disable it (not needed)

### 2b. Create the database (Firestore)
1. In your Firebase project, click **"Build"** in the left sidebar
2. Click **"Firestore Database"**
3. Click **"Create database"**
4. Choose **"Start in test mode"** (easier for getting started)
5. Pick any location → click **Done**

### 2c. Get your secret key
1. In Firebase, click the **gear icon** (top left, next to "Project Overview")
2. Click **"Project settings"**
3. Click the **"Service accounts"** tab
4. Click **"Generate new private key"**
5. A JSON file will download — open it
6. Open your `serviceAccountKey.json` file and **replace everything** in it with the contents of the downloaded file
7. Save `serviceAccountKey.json`

> ⚠️ Never share this file or commit it to GitHub — it gives full access to your database.

---

## Step 3 — Install dependencies

Open Terminal (Mac) or Command Prompt (Windows), navigate to the `bugtracker` folder:

```bash
cd path/to/bugtracker
npm install
```

This downloads Express, Socket.io, and Firebase — takes about 30 seconds.

---

## Step 4 — Run the server locally

```bash
node server.js
```

You should see:
```
BugTracker server running on port 3000
```

Now open your browser and go to:
```
http://localhost:3000
```

The app is live! You can use it right now on your own machine.

To stop the server, press `Ctrl + C` in the terminal.

---

## Step 5 — Share it with your team (deploy to Railway)

Right now only you can see it. To share with Dev, Tester, and Manager, deploy it online for free.

### 5a. Create a free Railway account
1. Go to **https://railway.app**
2. Sign up with GitHub (easiest) or email

### 5b. Push your code to GitHub first
1. Go to **https://github.com** and create a new repository called `bugtracker`
2. In your terminal, inside the `bugtracker` folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/bugtracker.git
   git push -u origin main
   ```
   > ⚠️ Before doing this, create a `.gitignore` file with this content to protect your key:
   > ```
   > node_modules/
   > serviceAccountKey.json
   > ```

### 5c. Add your Firebase key to Railway as an environment variable
Since `serviceAccountKey.json` is not in GitHub (for security), you need to give Railway the key a different way:

1. In Railway, create your project and connect your GitHub repo
2. Go to your service → **Variables** tab
3. Add a variable:
   - Name: `FIREBASE_KEY`
   - Value: paste the entire contents of your `serviceAccountKey.json` file

4. In `server.js`, change the Firebase init section to read from this variable:
   ```javascript
   // Replace this:
   const serviceAccount = require('./serviceAccountKey.json');

   // With this:
   const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
   ```

### 5d. Deploy
1. In Railway, click **"Deploy"**
2. Wait ~1 minute
3. Railway gives you a URL like `https://bugtracker-production-abc1.up.railway.app`

Share this URL with everyone on your team. That's it — they open it in any browser, pick their role, and are live instantly.

---

## How roles work

| Role | Can do |
|---|---|
| **Developer** | Start working on bugs, mark as Fixed, add further change notes |
| **Tester** | Raise new bugs, retest Fixed bugs, close or reopen |
| **Manager** | View everything, read-only (no status changes) |

Everyone gets real-time notifications for actions relevant to them.

---

## Notification flow

| Action | Dev notified | Tester notified | Manager notified |
|---|---|---|---|
| Bug raised | ✅ (if assigned) | — | ✅ |
| Dev starts work | — | — | — |
| Dev marks Fixed | — | ✅ | ✅ |
| Dev adds change note | — | ✅ | ✅ |
| Tester reopens bug | ✅ | — | ✅ |
| Tester closes bug | ✅ | — | ✅ |

---

## Troubleshooting

**"Cannot find module './serviceAccountKey.json'"**
→ Make sure the file exists in the same folder as `server.js` and contains valid JSON from Firebase.

**"Could not connect to server"**
→ The server isn't running. Run `node server.js` in your terminal first.

**"FirebaseError: PERMISSION_DENIED"**
→ Your Firestore is not in test mode, or the service account key is wrong. Go to Firebase → Firestore → Rules and temporarily set `allow read, write: if true;` for testing.

**Notifications not showing on Railway**
→ Make sure the `FIREBASE_KEY` environment variable is set in Railway and you've updated `server.js` to use `process.env.FIREBASE_KEY`.

---

## Quick-start cheat sheet

```bash
# Every time you want to run it locally:
cd path/to/bugtracker
node server.js
# Then open: http://localhost:3000
```
