// admin-dashboard.js (Final: Fixed User Name Lookup + Integrated Scanner)
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import {
  doc,
  getDoc,
  collection,
  query,
  onSnapshot,
  orderBy,
  limit,
  addDoc,           // Added for scanner
  updateDoc,        // Added for scanner
  where,            // Added for scanner
  getDocs,          // Added for scanner
  serverTimestamp   // Added for scanner
} from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

/* ------------- Safe DOM helpers ------------- */
const $ = (id) => document.getElementById(id);
const safeText = (id, text) => { 
    const el = $(id); 
    if (el) el.textContent = text; 
};

/* ------------- State Management ------------- */
let currentTab = 'today'; 
let gateLogs = [];        
let bookLogs = [];        
let allUsersMap = {}; // Maps UserID -> User Data (Name, Enrollment)

console.log('Admin Dashboard loaded.');

/* ------------- UI Render Helpers ------------- */
function renderUsers(users) {
  const container = $('adminUsersList');
  if (!container) return; 
  container.innerHTML = users.map(u => `
    <div class="user-row flex justify-between items-center p-2 hover:bg-gray-50 border-b" data-uid="${u.id}">
      <div>
        <strong>${u.fullName || '—'}</strong> 
        <span class="text-xs text-gray-500">(${u.enrollment || ''})</span>
      </div>
      <button class="show-qr text-blue-600 text-xs border border-blue-600 px-2 py-1 rounded hover:bg-blue-600 hover:text-white transition" data-uid="${u.id}">QR</button>
    </div>
  `).join('');
  
  container.querySelectorAll('.show-qr').forEach(btn => {
    btn.addEventListener('click', () => openQrModal(btn.dataset.uid));
  });
}

function renderBorrowed(borrowedDocs) {
  const container = $('borrowedListContainer');
  if (!container) return;
  container.innerHTML = borrowedDocs.map(d => {
    const mm = d.data;
    const user = allUsersMap[mm.userId] || { fullName: 'Unknown User' };
    const userName = mm.userName || user.fullName;
    
    const due = mm.dueDate ? (mm.dueDate.toDate ? mm.dueDate.toDate().toLocaleDateString() : new Date(mm.dueDate).toLocaleDateString()) : 'N/A';
    
    return `
      <div class="borrow-row p-2 border-b text-sm">
        <div class="font-medium text-gray-800">${mm.title || mm.bookTitle || 'Book'}</div>
        <div class="text-xs text-gray-500">By: ${userName} • Due: <span class="text-red-500">${due}</span></div>
      </div>`;
  }).join('');
}

/* ------------- CORE LOGIC: Logs Table ------------- */
function renderLogsTable() {
    const tbody = $('logsTableBody');
    if(!tbody) return;

    let filteredData = [];
    const today = new Date();
    today.setHours(0,0,0,0);

    const getDate = (item) => {
        const t = item.issueDate || item.issuedAt || item.timestamp || item.returnDate;
        return (t && t.toDate) ? t.toDate() : new Date();
    };

    if (currentTab === 'today') {
        filteredData = gateLogs.filter(log => getDate(log) >= today);
        toggleTransactionColumn(false);
    } else if (currentTab === 'history') {
        filteredData = gateLogs.filter(log => getDate(log) < today);
        toggleTransactionColumn(false);
    } else if (currentTab === 'books') {
        filteredData = bookLogs; 
        toggleTransactionColumn(true);
    }

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-8 text-center text-gray-400 italic">No records found.</td></tr>`;
        return;
    }

    const rows = filteredData.map(log => {
        const dateObj = getDate(log);
        const dateStr = dateObj.toLocaleDateString();
        
        // --- FIXED NAME LOOKUP ---
        let name = 'Unknown';
        let enrollment = '—';
        let branch = log.branch || log.userDepartment || '-';

        if (log.userName) name = log.userName;
        if (log.name) name = log.name;
        if (log.enrollment) enrollment = log.enrollment;

        if (log.userId && (name === 'Unknown' || enrollment === '—')) {
            const userProfile = allUsersMap[log.userId];
            if (userProfile) {
                name = userProfile.fullName || userProfile.name;
                enrollment = userProfile.enrollment || enrollment;
                if(!branch || branch === '-') branch = userProfile.branch || userProfile.department || '-';
            }
        }
        
        let timeIn = '-';
        let timeOut = '-';
        let transactionBadge = '';

        if (currentTab === 'books') {
            const rawType = log.transactionType || (log.returned ? 'returned' : 'borrow');
            const type = rawType.toLowerCase();
            const isBorrow = type.includes('borrow') || type.includes('issue');
            const color = isBorrow ? 'bg-orange-100 text-orange-800' : 'bg-green-100 text-green-800';
            
            transactionBadge = `<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${color}">${type.toUpperCase()}</span>`;
            
            const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (isBorrow) timeIn = timeStr;
            else timeOut = timeStr;
            
            if(log.bookName || log.title) name += ` <br><span class="text-xs text-blue-600 italic">${log.bookName || log.title}</span>`;
            
        } else {
            const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const type = (log.type || '').toLowerCase();
            if (type === 'entry' || log.timeIn) timeIn = log.timeIn || timeStr;
            if (type === 'exit' || log.timeOut) timeOut = log.timeOut || timeStr;
        }

        return `
            <tr class="hover:bg-gray-50 transition-colors border-b border-gray-100">
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${enrollment}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${name}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${log.sem || '-'}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${branch}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${dateStr}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-green-600 font-medium">${timeIn}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-red-600 font-medium">${timeOut}</td>
                ${currentTab === 'books' ? `<td class="px-6 py-4 whitespace-nowrap text-sm">${transactionBadge}</td>` : ''}
            </tr>
        `;
    });

    tbody.innerHTML = rows.join('');
}

function toggleTransactionColumn(show) {
    const col = $('colTransaction');
    if(col) show ? col.classList.remove('hidden') : col.classList.add('hidden');
}

/* ------------- Tab Switching ------------- */
const tabToday = $('tabToday');
const tabHistory = $('tabHistory');
const tabBooks = $('tabBooks');

function setActiveTab(selectedBtn, mode) {
    [tabToday, tabHistory, tabBooks].forEach(btn => {
        if(btn) {
            btn.classList.remove('text-blue-600', 'border-b-2', 'border-blue-600');
            btn.classList.add('text-gray-500', 'hover:text-gray-700');
        }
    });
    if(selectedBtn) {
        selectedBtn.classList.remove('text-gray-500', 'hover:text-gray-700');
        selectedBtn.classList.add('text-blue-600', 'border-b-2', 'border-blue-600');
    }
    currentTab = mode;
    renderLogsTable();
}

if(tabToday) tabToday.addEventListener('click', () => setActiveTab(tabToday, 'today'));
if(tabHistory) tabHistory.addEventListener('click', () => setActiveTab(tabHistory, 'history'));
if(tabBooks) tabBooks.addEventListener('click', () => setActiveTab(tabBooks, 'books'));

/* ------------- Real-time Listeners ------------- */
let unsubscribes = [];

function startRealtimeListeners() {
  unsubscribes.forEach(u => u());
  unsubscribes = [];

  // 1. Users
  unsubscribes.push(onSnapshot(collection(db, 'users'), (snap) => {
    const usersList = [];
    allUsersMap = {}; 
    snap.forEach(s => {
        const u = s.data();
        const uid = s.id;
        usersList.push({ id: uid, ...u });
        allUsersMap[uid] = u; 
    });
    renderUsers(usersList);
    renderLogsTable();
  }, (err) => console.error("Permission Error (Users):", err)));

  // 2. Borrowed Books & Returned Books
  const borrowedRef = collection(db, 'borrowedBooks');
  unsubscribes.push(onSnapshot(borrowedRef, (snap) => {
    let total = 0, overdue = 0;
    const now = Date.now();
    const borrowedForHistory = [];
    const borrowedForList = [];
    
    snap.forEach(s => {
      const data = s.data();
      if (!data.returned) { 
          total++;
          const dVal = data.dueDate || data.dueAt;
          const dueMs = (dVal && dVal.toDate) ? dVal.toDate().getTime() : (dVal ? new Date(dVal).getTime() : 0);
          if (dueMs && dueMs < now) overdue++;
          borrowedForList.push({ id: s.id, data });
      }
      borrowedForHistory.push({ id: s.id, ...data, source: 'borrowedBooks' });
    });
    
    safeText('totalBorrowedCount', String(total));
    safeText('overdueCount', String(overdue));
    renderBorrowed(borrowedForList);
    mergeBookLogs(borrowedForHistory, 'borrowedBooks');
  }));

  // 3. Books Metric
  unsubscribes.push(onSnapshot(collection(db, 'books'), (snap) => {
    safeText('totalBooksCount', String(snap.size));
  }, (err) => console.error("Permission Error (Books):", err)));

  // 4. Activity Logs (Gate)
  const logsRef = collection(db, 'activityLogs');
  unsubscribes.push(onSnapshot(query(logsRef, orderBy('timestamp', 'desc'), limit(100)), (snap) => {
    gateLogs = [];
    snap.forEach(doc => gateLogs.push({ id: doc.id, ...doc.data() }));
    if(currentTab === 'today' || currentTab === 'history') renderLogsTable();
  }, (err) => console.error("Permission Error (Logs):", err)));

  // 5. Book Transactions
  const bookTransRef = collection(db, 'bookTransactions');
  const bookTransQuery = query(bookTransRef, orderBy('issueDate', 'desc'), limit(100));
  
  unsubscribes.push(onSnapshot(bookTransQuery, (snap) => {
      const logs = [];
      snap.forEach(d => logs.push({ id: d.id, ...d.data(), source: 'bookTransactions' }));
      mergeBookLogs(logs, 'bookTransactions');
  }, (err) => {
      onSnapshot(query(bookTransRef, limit(100)), (s) => {
          const logs = [];
          s.forEach(d => logs.push({ id: d.id, ...d.data(), source: 'bookTransactions' }));
          mergeBookLogs(logs, 'bookTransactions');
      });
  }));
}

let rawBookData = { borrowedBooks: [], bookTransactions: [] };
function mergeBookLogs(newData, source) {
    rawBookData[source] = newData;
    bookLogs = [...rawBookData.bookTransactions, ...rawBookData.borrowedBooks];
    
    bookLogs.sort((a, b) => {
        const dateA = a.issueDate || a.issuedAt || a.timestamp || 0;
        const dateB = b.issueDate || b.issuedAt || b.timestamp || 0;
        return (dateB.toDate ? dateB.toDate() : dateB) - (dateA.toDate ? dateA.toDate() : dateA);
    });

    if(currentTab === 'books') renderLogsTable();
}

/* ------------- QR SCANNER & CHECK-IN LOGIC ------------- */
const scannerModal = $('scannerModal');
const openScannerBtn = $('openScannerBtn');
const closeScannerModal = $('closeScannerModal');
const scannerModalOverlay = $('scannerModalOverlay');
const messageBox = $('scanMessage');

let html5QrcodeScanner = null;
let lastScannedString = "";

function showMessage(text, type) {
    if (!messageBox) return;
    messageBox.textContent = text;
    messageBox.classList.remove('hidden', 'bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-yellow-100', 'text-yellow-800');
    
    if (type === 'success') messageBox.classList.add('bg-green-100', 'text-green-800');
    else if (type === 'error') messageBox.classList.add('bg-red-100', 'text-red-800');
    else if (type === 'warning') messageBox.classList.add('bg-yellow-100', 'text-yellow-800');
    
    setTimeout(() => messageBox.classList.add('hidden'), 4000);
}

async function handleScan(decodedText) {
    if (decodedText === lastScannedString) return;
    lastScannedString = decodedText;
    setTimeout(() => lastScannedString = "", 4000);

    let userData;
    try {
        userData = JSON.parse(decodeURIComponent(atob(decodedText)));
    } catch (err) {
        showMessage("Invalid QR Code Format.", "error");
        return;
    }

    const enrollment = userData.enrollment || userData.uid || "N/A";
    const name = userData.fullName || userData.fullname || "Unknown User";
    const userId = userData.uid || "Unknown";
    const branch = userData.department || userData.branch || "-";
    const sem = userData.semester || userData.sem || "-";
    
    try {
        // Query activityLogs specifically to blend seamlessly with your table
        const q = query(collection(db, "activityLogs"), where("enrollment", "==", enrollment), where("status", "==", 1));
        const querySnapshot = await getDocs(q);

        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (querySnapshot.empty) {
            // CHECK IN
            await addDoc(collection(db, "activityLogs"), {
                userId: userId,
                enrollment: enrollment,
                name: name,
                branch: branch,
                sem: sem,
                status: 1,
                timestamp: serverTimestamp(),
                timeIn: timeStr,
                timeOut: null
            });
            showMessage(`✅ Checked IN: ${name}`, "success");
        } else {
            // CHECK OUT
            const activeDoc = querySnapshot.docs[0];
            const logData = activeDoc.data();
            
            const checkInTime = logData.timestamp ? logData.timestamp.toDate() : now; 
            const timeDiffMs = now - checkInTime;

            const COOLDOWN_MS = 5 * 60 * 1000;
            if (timeDiffMs < COOLDOWN_MS) {
                const remainingMinutes = Math.ceil((COOLDOWN_MS - timeDiffMs) / 60000);
                showMessage(`⏳ Wait ${remainingMinutes} min(s) before checking out.`, "warning");
                return; 
            }

            // Update existing log to keep DB clean
            await updateDoc(doc(db, "activityLogs", activeDoc.id), {
                status: 0,
                timeOut: timeStr
            });
            showMessage(`👋 Checked OUT: ${name}`, "success");
        }
    } catch (error) {
        console.error("Scanner DB Error:", error);
        showMessage("Database error.", "error");
    }
}

function openScanner() {
    scannerModal.classList.remove('hidden');
    if (!html5QrcodeScanner) {
        const scannerConfig = {
            fps: 15, 
            qrbox: { width: 300, height: 300 }, 
            disableFlip: false,
            formatsToSupport: [ window.Html5QrcodeSupportedFormats.QR_CODE ], 
            videoConstraints: {
                facingMode: "environment", 
                width: { min: 640, ideal: 1280, max: 1920 },
                height: { min: 480, ideal: 720, max: 1080 }
            }
        };
        html5QrcodeScanner = new window.Html5QrcodeScanner("reader", scannerConfig, false);
        html5QrcodeScanner.render(handleScan, () => {}); // Empty function ignores background errors
    }
}

function closeScanner() {
    scannerModal.classList.add('hidden');
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear().then(() => {
            html5QrcodeScanner = null;
        }).catch(err => console.error("Failed to clear scanner", err));
    }
}

if (openScannerBtn) openScannerBtn.addEventListener('click', openScanner);
if (closeScannerModal) closeScannerModal.addEventListener('click', closeScanner);
if (scannerModalOverlay) scannerModalOverlay.addEventListener('click', closeScanner);


/* ------------- Auth ------------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  startRealtimeListeners();
});