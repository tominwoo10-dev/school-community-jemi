const SUPABASE_URL = "https://nsnpmnjmbzecpvswcnlc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_XVPVmjOt_6mgbTTS-8m4SA_h9YEg4d0";

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (selector) => document.querySelector(selector);

let currentUser = null, currentProfile = null, currentBoard = "고민", selectedPostId = null, isAdmin = false;
let activeConversationId = null, activeChatPartner = null, chatRealtimeChannel = null, dmSearchDebounce = null;
let currentPageName = "home";
let conversationsCache = [], searchResultsCache = [], chatMessagesCache = [];
let reportsCache = [];
let activeReportTarget = null; // { type: 'post'|'message', targetId, excerpt }
let myConversationIds = new Set();
let globalDmChannel = null;
let adminAccountResult = null;
let currentCabbagePeriod = "daily";
let justCabbagedPostId = null;

// 3차 업데이트 상태 변수
let cabbageTotalCache = new Map();
let notificationsCache = [];
let notificationChannel = null;
let bannedWordsCache = [];
let viewedProfileUserId = null;
let profileActiveTab = "posts";
let profileCache = { posts: [], comments: [] };
let lastSearchQuery = "";
let adminPostSearchCache = [];
let forceLogoutChannel = null;
let sessionStartedAt = null;

const studentEmail = (studentId) => `student-${studentId.trim()}@school-community.invalid`;
const teacherEmail = (name, birth) => `teacher-${name.trim().replace(/\s+/g, "")}-${birth.replace(/-/g, "")}@school-community.invalid`;
const escapeHtml = (text) => { const div = document.createElement("div"); div.textContent = text || ""; return div.innerHTML; };
const time = (value) => value ? new Date(value).toLocaleString("ko-KR") : "방금 전";

function shortTime(value) {
  if (!value) return "";
  const d = new Date(value);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function updateHeader() {
  if (currentUser) {
    $("#guest-nav").style.display = "none";
    $("#member-nav").style.display = "flex";
    renderCurrentUserLabel();
  } else {
    $("#guest-nav").style.display = "flex";
    $("#member-nav").style.display = "none";
    $("#current-user").textContent = "";
  }
}

function renderCurrentUserLabel() {
  if (!currentUser || !currentProfile) {
    $("#current-user").textContent = currentUser ? "정보 연동 중.." : "";
    return;
  }
  const cached = cabbageTotalCache.get(currentUser.id);
  if (cached == null) {
    $("#current-user").textContent = `${currentProfile.nickname} 님`;
    ensureCabbageTotals([currentUser.id]).then(() => renderCurrentUserLabel());
  } else {
    $("#current-user").textContent = `${currentProfile.nickname} 님 🥬${cached}`;
  }
}

// ------------------------------------------------------------
// 다크모드
// ------------------------------------------------------------

function initTheme() {
  if (localStorage.getItem("theme") === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "light");
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("theme", "dark");
  }
}

$("#theme-toggle").addEventListener("click", toggleTheme);
$("#theme-toggle-member").addEventListener("click", toggleTheme);
initTheme();

// ------------------------------------------------------------
// 로그인/회원가입 학생·선생님 탭 전환
// ------------------------------------------------------------

function switchRoleTab(area, role) {
  document.querySelectorAll(`#${area}-role-tabs .role-tab-btn`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.roleTab === role);
  });
  if (area === "login") {
    $("#login-form").hidden = role !== "student";
    $("#teacher-login-form").hidden = role !== "teacher";
  } else {
    $("#signup-form").hidden = role !== "student";
    $("#teacher-signup-form").hidden = role !== "teacher";
  }
}

// ------------------------------------------------------------
// 🥬 닉네임 옆 배추 총합 캐시
// ------------------------------------------------------------

async function ensureCabbageTotals(authorIds) {
  const idsToFetch = [...new Set((authorIds || []).filter(Boolean))].filter((id) => !cabbageTotalCache.has(id));
  if (!idsToFetch.length) return;
  const { data, error } = await supabase
    .from("school_community_posts")
    .select("author_id,cabbage_count")
    .in("author_id", idsToFetch);
  if (error) return;
  const sums = {};
  idsToFetch.forEach((id) => { sums[id] = 0; });
  (data || []).forEach((p) => { sums[p.author_id] = (sums[p.author_id] || 0) + (p.cabbage_count || 0); });
  Object.entries(sums).forEach(([id, total]) => cabbageTotalCache.set(id, total));
}

function cabbageBadge(authorId) {
  const total = cabbageTotalCache.get(authorId);
  return `<span class="mini-cabbage">🥬${total ?? 0}</span>`;
}

function authorLinkAttrs(authorId) {
  return `class="author-link" data-user-id="${authorId || ""}"`;
}

// ------------------------------------------------------------
// 🔔 알림 시스템
// ------------------------------------------------------------

async function createNotification(userId, type, message, targetType, targetId) {
  if (!userId) return;
  await supabase.from("school_community_notifications").insert({
    user_id: userId, type, message, target_type: targetType, target_id: targetId
  });
}

async function loadNotifications() {
  if (!currentUser) return;
  const { data, error } = await supabase
    .from("school_community_notifications")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return;
  notificationsCache = data || [];
  renderNotifications();
  updateNotificationBadge();
}

function updateNotificationBadge() {
  const badge = $("#notification-badge");
  if (!badge) return;
  const unread = notificationsCache.filter((n) => !n.is_read).length;
  badge.textContent = unread > 99 ? "99+" : String(unread);
  badge.hidden = unread === 0;
}

function renderNotifications() {
  const list = $("#notification-list");
  if (!list) return;
  list.innerHTML = notificationsCache.length ? notificationsCache.map((n) => `
    <button class="notification-row ${n.is_read ? "" : "unread"}" data-notification-id="${n.id}" data-target-type="${n.target_type || ""}" data-target-id="${n.target_id || ""}" type="button">
      <span class="notification-message">${escapeHtml(n.message)}</span>
      <span class="notification-time">${time(n.created_at)}</span>
    </button>
  `).join("") : `<div class="notification-empty">알림이 없습니다.</div>`;
}

async function markNotificationRead(id) {
  const notif = notificationsCache.find((n) => n.id === id);
  if (notif && !notif.is_read) {
    notif.is_read = true;
    renderNotifications();
    updateNotificationBadge();
    await supabase.from("school_community_notifications").update({ is_read: true }).eq("id", id);
  }
}

function subscribeNotifications() {
  unsubscribeNotifications();
  notificationChannel = supabase
    .channel(`notif-${currentUser.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "school_community_notifications", filter: `user_id=eq.${currentUser.id}` }, (payload) => {
      notificationsCache.unshift(payload.new);
      renderNotifications();
      updateNotificationBadge();
      toast("🔔 새 알림이 도착했습니다.");
    })
    .subscribe();
}

function unsubscribeNotifications() {
  if (notificationChannel) { supabase.removeChannel(notificationChannel); notificationChannel = null; }
}

$("#notification-nav-button").addEventListener("click", () => {
  const panel = $("#notification-panel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadNotifications();
});
$("#notification-close").addEventListener("click", () => { $("#notification-panel").hidden = true; });

async function openConversationById(conversationId) {
  if (!currentUser) return;
  let conv = conversationsCache.find((c) => c.id === conversationId);
  if (!conv) {
    const { data } = await supabase.from("school_community_conversations").select("*").eq("id", conversationId).maybeSingle();
    if (!data) return toast("대화를 찾을 수 없습니다.");
    const isUser1 = data.user1 === currentUser.id;
    conv = { ...data, partnerId: isUser1 ? data.user2 : data.user1, partnerNickname: isUser1 ? data.user2_nickname : data.user1_nickname };
  }
  activeConversationId = conv.id;
  activeChatPartner = { id: conv.partnerId, nickname: conv.partnerNickname };
  showPage("chat");
}

function periodLabel(period) {
  return period === "daily" ? "일간" : period === "weekly" ? "주간" : "월간";
}

// ------------------------------------------------------------
// 🚫 금칙어 시스템
// ------------------------------------------------------------

async function loadBannedWords() {
  const { data, error } = await supabase.from("school_community_banned_words").select("*").order("created_at", { ascending: false });
  if (!error) bannedWordsCache = data || [];
}

function containsBannedWord(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return bannedWordsCache.some((w) => w.word && lower.includes(w.word.toLowerCase()));
}

// ------------------------------------------------------------
// 👤 프로필 페이지
// ------------------------------------------------------------

function openProfile(userId) {
  if (!userId) return;
  viewedProfileUserId = userId;
  profileActiveTab = "posts";
  document.querySelectorAll("#profile-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.profileTab === "posts"));
  showPage("profile");
}

$("#my-profile-button").addEventListener("click", () => { if (currentUser) openProfile(currentUser.id); });

async function loadProfilePage() {
  if (!viewedProfileUserId) return;
  const isOwn = currentUser && viewedProfileUserId === currentUser.id;

  const { data: profile, error } = await supabase
    .from("school_community_profiles")
    .select("id,nickname,role,student_id,avatar_url,created_at")
    .eq("id", viewedProfileUserId)
    .maybeSingle();

  if (error || !profile) { toast("프로필을 불러오지 못했습니다."); return showPage("boards"); }

  $("#profile-nickname-display").textContent = profile.nickname;
  $("#profile-nickname-display").hidden = false;
  $("#profile-nickname-edit").hidden = true;

  const wrap = $("#profile-avatar-wrap");
  const avatarImg = $("#profile-avatar-img");
  if (profile.avatar_url) {
    avatarImg.src = profile.avatar_url;
    wrap.classList.remove("no-avatar");
  } else {
    avatarImg.removeAttribute("src");
    wrap.classList.add("no-avatar");
  }

  $("#profile-student-id-display").textContent = (isOwn && profile.student_id) ? `학번 ${profile.student_id}` : "";
  $("#profile-joined-display").textContent = profile.created_at ? `가입일 ${new Date(profile.created_at).toLocaleDateString("ko-KR")}` : "";

  $("#profile-avatar-edit-btn").hidden = !isOwn;
  $("#profile-nickname-edit-btn").hidden = !isOwn;
  $("#profile-dm-button").hidden = isOwn || !currentUser;

  const { data: posts } = await supabase
    .from("school_community_posts")
    .select("id,title,board_type,cabbage_count,comment_count,created_at")
    .eq("author_id", viewedProfileUserId)
    .order("created_at", { ascending: false });

  const { data: comments } = await supabase
    .from("school_community_comments")
    .select("id,post_id,content,created_at")
    .eq("author_id", viewedProfileUserId)
    .order("created_at", { ascending: false });

  const totalCabbage = (posts || []).reduce((sum, p) => sum + (p.cabbage_count || 0), 0);
  cabbageTotalCache.set(viewedProfileUserId, totalCabbage);

  $("#profile-cabbage-total").textContent = totalCabbage;
  $("#profile-cabbage-inline").textContent = `🥬${totalCabbage}`;
  $("#profile-post-count").textContent = (posts || []).length;
  $("#profile-comment-count").textContent = (comments || []).length;

  profileCache = { posts: posts || [], comments: comments || [] };
  renderProfileTabContent();

  $("#profile-dm-button").onclick = () => startConversationAndOpen(viewedProfileUserId, profile.nickname);
  $("#profile-avatar-edit-btn").onclick = () => $("#profile-avatar-input").click();
  $("#profile-nickname-edit-btn").onclick = () => {
    $("#profile-nickname-display").hidden = true;
    $("#profile-nickname-edit-btn").hidden = true;
    $("#profile-nickname-edit").hidden = false;
    $("#profile-nickname-input").value = profile.nickname;
  };
}

function renderProfileTabContent() {
  const box = $("#profile-tab-content");
  if (!box) return;
  if (profileActiveTab === "posts") {
    box.innerHTML = profileCache.posts.length ? profileCache.posts.map((p) => `
      <button class="profile-list-row" data-post-id="${p.id}" type="button">
        <span class="profile-list-title">${escapeHtml(p.title)}</span>
        <span class="profile-list-meta">🥬 ${p.cabbage_count || 0} · 💬 ${p.comment_count || 0} · ${shortTime(p.created_at)}</span>
      </button>
    `).join("") : `<div class="admin-empty">작성한 게시글이 없습니다.</div>`;
  } else if (profileActiveTab === "comments") {
    box.innerHTML = profileCache.comments.length ? profileCache.comments.map((c) => `
      <button class="profile-list-row" data-post-id="${c.post_id}" type="button">
        <span class="profile-list-title">${escapeHtml((c.content || "").slice(0, 60))}</span>
        <span class="profile-list-meta">${shortTime(c.created_at)}</span>
      </button>
    `).join("") : `<div class="admin-empty">작성한 댓글이 없습니다.</div>`;
  } else {
    const topPosts = [...profileCache.posts].sort((a, b) => (b.cabbage_count || 0) - (a.cabbage_count || 0)).slice(0, 5);
    box.innerHTML = topPosts.length ? topPosts.map((p) => `
      <button class="profile-list-row" data-post-id="${p.id}" type="button">
        <span class="profile-list-title">${escapeHtml(p.title)}</span>
        <span class="profile-list-meta">🥬 배추 ${p.cabbage_count || 0}개</span>
      </button>
    `).join("") : `<div class="admin-empty">받은 배추가 있는 게시글이 없습니다.</div>`;
  }
}

$("#profile-avatar-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file || !currentUser) return;
  const path = `${currentUser.id}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
  if (uploadError) return toast(`프로필 사진 업로드 실패: ${uploadError.message}`);
  const { data: publicUrlData } = supabase.storage.from("avatars").getPublicUrl(path);
  const avatarUrl = publicUrlData?.publicUrl;
  const { error } = await supabase.from("school_community_profiles").update({ avatar_url: avatarUrl }).eq("id", currentUser.id);
  if (error) return toast(`프로필 저장 실패: ${error.message}`);
  toast("프로필 사진이 변경되었습니다.");
  loadProfilePage();
});

$("#profile-nickname-save").addEventListener("click", async () => {
  const value = $("#profile-nickname-input").value.trim();
  if (value.length < 2 || value.length > 20) return toast("닉네임은 2자 이상 20자 이하여야 합니다.");
  const { error } = await supabase.from("school_community_profiles").update({ nickname: value }).eq("id", currentUser.id);
  if (error) return toast(`닉네임 변경 실패: ${error.message}`);
  currentProfile.nickname = value;
  updateHeader();
  toast("닉네임이 변경되었습니다.");
  loadProfilePage();
});
$("#profile-nickname-cancel").addEventListener("click", () => {
  $("#profile-nickname-display").hidden = false;
  $("#profile-nickname-edit-btn").hidden = false;
  $("#profile-nickname-edit").hidden = true;
});

// ------------------------------------------------------------
// 🔍 검색
// ------------------------------------------------------------

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#search-input").value.trim();
  if (!query) return;
  lastSearchQuery = query;
  showPage("search");
});

async function loadSearchResults() {
  const box = $("#search-result-list");
  const summary = $("#search-summary");
  if (!box) return;
  if (!lastSearchQuery) { box.innerHTML = ""; if (summary) summary.textContent = ""; return; }
  if (summary) summary.textContent = `"${lastSearchQuery}" 검색 결과`;
  box.innerHTML = `<div class="cabbage-rank-empty">검색 중입니다...</div>`;

  const escaped = lastSearchQuery.replace(/[%_,]/g, "");
  const { data, error } = await supabase
    .from("school_community_posts")
    .select("*")
    .or(`title.ilike.%${escaped}%,content.ilike.%${escaped}%,author_nickname.ilike.%${escaped}%`)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) { box.innerHTML = `<div class="cabbage-rank-empty">검색 중 오류가 발생했습니다.</div>`; return toast(`검색 실패: ${error.message}`); }
  if (!data || !data.length) { box.innerHTML = `<div class="cabbage-rank-empty">일치하는 결과가 없습니다.</div>`; return; }

  await ensureCabbageTotals(data.map((p) => p.author_id));
  box.innerHTML = data.map((p) => renderPostRow(p, false)).join("");
}

// ------------------------------------------------------------
// DM 배지(안 읽은 메시지 알림)
// ------------------------------------------------------------

async function refreshMyConversationIds() {
  if (!currentUser) return;
  const { data } = await supabase
    .from("school_community_conversations")
    .select("id")
    .or(`user1.eq.${currentUser.id},user2.eq.${currentUser.id}`);
  myConversationIds = new Set((data || []).map((c) => c.id));
}

function setDmBadge(on) {
  const btn = $("#dm-nav-button");
  if (btn) btn.classList.toggle("has-unread", on);
}

function subscribeGlobalDmBadge() {
  unsubscribeGlobalDmBadge();
  globalDmChannel = supabase
    .channel("global-dm-badge")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "school_community_messages" }, (payload) => {
      const msg = payload.new;
      if (!currentUser || msg.sender_id === currentUser.id) return;
      if (!myConversationIds.has(msg.conversation_id)) return;
      if (currentPageName === "chat" && msg.conversation_id === activeConversationId) return;
      setDmBadge(true);
    })
    .subscribe();
}

function unsubscribeGlobalDmBadge() {
  if (globalDmChannel) { supabase.removeChannel(globalDmChannel); globalDmChannel = null; }
}

// ------------------------------------------------------------
// 🚪 관리자 강제 로그아웃 감지
// ------------------------------------------------------------

function subscribeForceLogout() {
  unsubscribeForceLogout();
  sessionStartedAt = new Date();
  forceLogoutChannel = supabase
    .channel(`force-logout-${currentUser.id}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "school_community_profiles", filter: `id=eq.${currentUser.id}` }, (payload) => {
      const kickAt = payload.new.force_logout_at;
      if (kickAt && new Date(kickAt) > sessionStartedAt) {
        toast("관리자에 의해 로그아웃 처리되었습니다.");
        supabase.auth.signOut();
      }
    })
    .subscribe();
}

function unsubscribeForceLogout() {
  if (forceLogoutChannel) { supabase.removeChannel(forceLogoutChannel); forceLogoutChannel = null; }
}

// ------------------------------------------------------------
// 페이지 라우팅
// ------------------------------------------------------------

function showPage(name) {
  if (["boards", "write", "detail", "dms", "chat", "profile", "search"].includes(name) && !currentUser) {
    toast("로그인이 필요한 페이지입니다.");
    name = "login";
  }

  if (name !== "chat") unsubscribeFromChat();
  document.body.style.overflow = "";
  currentPageName = name;

  if (name === "dms" || name === "chat") setDmBadge(false);

  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
  const targetPage = $(`#page-${name}`);
  if (targetPage) targetPage.classList.add("active");

  if (name === "boards") loadPosts();
  if (name === "detail") loadDetail();
  if (name === "dms") loadConversations();
  if (name === "chat") loadChatMessages();
  if (name === "cabbage-board") loadCabbageRanking();
  if (name === "profile") loadProfilePage();
  if (name === "search") loadSearchResults();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------
// 게시판 (디시인사이드 스타일 한 줄 리스트 + 공지/개념글)
// ------------------------------------------------------------

function renderPostRow(post, isHot) {
  const badges = `${post.is_notice ? `<span class="tag-notice">📌 공지</span>` : ""}${isHot ? `<span class="tag-hot">개념</span>` : ""}`;
  return `
    <button class="post-row-line${post.is_notice ? " is-notice" : ""}" data-post-id="${post.id}" type="button">
      <span class="col-title">${badges}${escapeHtml(post.title)}</span>
      <span class="col-author author-link" data-user-id="${post.author_id}">${escapeHtml(post.author_nickname)} ${cabbageBadge(post.author_id)}</span>
      <span class="col-stat">👀 ${post.view_count || 0}</span>
      <span class="col-stat">🥬 ${post.cabbage_count}</span>
      <span class="col-stat">💬 ${post.comment_count}</span>
      <span class="col-time">${shortTime(post.created_at)}</span>
    </button>
  `;
}

async function loadPosts() {
  const { data: posts, error } = await supabase
    .from("school_community_posts")
    .select("*")
    .eq("board_type", currentBoard)
    .order("created_at", { ascending: false });

  if (error) return toast(`글 목록 수신 실패: ${error.message}`);

  const postList = $("#post-list");
  if (!postList) return;

  if (!posts.length) {
    postList.innerHTML = `<div class="post-row-line empty">등록된 글이 존재하지 않습니다.</div>`;
    return;
  }

  await ensureCabbageTotals(posts.map((p) => p.author_id));

  const notices = posts.filter((p) => p.is_notice);
  const normal = posts.filter((p) => !p.is_notice);
  const topIds = new Set(
    [...normal]
      .filter((p) => p.cabbage_count > 0)
      .sort((a, b) => b.cabbage_count - a.cabbage_count)
      .slice(0, 5)
      .map((p) => p.id)
  );

  postList.innerHTML = [
    ...notices.map((p) => renderPostRow(p, false)),
    ...normal.map((p) => renderPostRow(p, topIds.has(p.id)))
  ].join("");
}

function buildCommentTree(comments) {
  const topLevel = comments.filter((c) => !c.parent_id);
  const repliesByParent = {};
  comments.filter((c) => c.parent_id).forEach((c) => {
    (repliesByParent[c.parent_id] ||= []).push(c);
  });
  return { topLevel, repliesByParent };
}

function renderCommentNode(comment, repliesByParent) {
  const replies = repliesByParent[comment.id] || [];
  return `
    <div class="comment" data-comment-id="${comment.id}">
      <strong ${authorLinkAttrs(comment.author_id)}>${escapeHtml(comment.author_nickname)}</strong> ${cabbageBadge(comment.author_id)}
      <span class="meta"> · ${time(comment.created_at)}</span>
      <p>${escapeHtml(comment.content)}</p>
      <button class="reply-toggle-btn" data-comment-id="${comment.id}" type="button">답글</button>
      <div class="reply-form-slot" id="reply-form-${comment.id}"></div>
      ${replies.length ? `<div class="reply-list">${replies.map((r) => `
        <div class="comment reply" data-comment-id="${r.id}">
          <strong ${authorLinkAttrs(r.author_id)}>${escapeHtml(r.author_nickname)}</strong> ${cabbageBadge(r.author_id)}
          <span class="meta"> · ${time(r.created_at)}</span>
          <p>${escapeHtml(r.content)}</p>
        </div>
      `).join("")}</div>` : ""}
    </div>
  `;
}

async function loadDetail() {
  if (!selectedPostId) return;

  // 증가 차단 레이스방지 RPC 호출
  await supabase.rpc("increment_view_count", { post_id: selectedPostId });

  const { data: post, error } = await supabase.from("school_community_posts").select("*").eq("id", selectedPostId).single();
  if (error) { toast("게시글을 찾을 수 없거나 이미 삭제 처리되었습니다."); return showPage("boards"); }

  const { data: myCabbage } = await supabase.from("school_community_cabbage_recommends").select("post_id").eq("post_id", post.id).maybeSingle();
  const ownPost = currentUser && post.author_id === currentUser.id;
  const dmBtnHtml = (!ownPost && currentUser) ? `<button class="text-button" id="btn-open-dm" type="button" style="font-size:12px; margin-left:8px;">✉ 쪽지 보내기</button>` : "";

  await ensureCabbageTotals([post.author_id]);

  const postDetail = $("#post-detail");
  if (!postDetail) return;

  const badges = `${post.is_notice ? `<span class="tag-notice">📌 공지</span>` : ""}`;

  postDetail.innerHTML = `
    <span class="badge">${post.board_type}</span>
    <h1>${badges}${escapeHtml(post.title)}</h1>
    <div class="meta"><span ${authorLinkAttrs(post.author_id)}>${escapeHtml(post.author_nickname)} ${cabbageBadge(post.author_id)}</span>${dmBtnHtml} · 👀 조회 ${post.view_count || 0} · ${time(post.created_at)}</div>
    <div class="detail-content">${escapeHtml(post.content)}</div>
    <div class="actions">
      <button class="cabbage" id="cabbage-button" type="button">${myCabbage ? "🥬 배추 추천 취소" : "🥬 배추 주기"} ${post.cabbage_count}</button>
      <span class="action-right">
        ${!ownPost ? `<button class="report-btn" id="report-post-button" type="button">🚩 신고</button>` : ""}
        ${isAdmin ? `<button class="notice-toggle-btn" id="notice-toggle-button" type="button">${post.is_notice ? "고정 해제" : "📌 상단 고정"}</button>` : ""}
        ${ownPost ? `<button class="danger" id="own-delete" type="button">글 삭제</button>` : ""}
      </span>
    </div>
  `;

  if (!ownPost && $("#btn-open-dm")) {
    $("#btn-open-dm").addEventListener("click", () => {
      startConversationAndOpen(post.author_id, post.author_nickname);
    });
  }

  $("#cabbage-button").addEventListener("click", () => toggleCabbage(post.id, Boolean(myCabbage)));
  if (!ownPost && $("#report-post-button")) {
    $("#report-post-button").addEventListener("click", () => openReportModal("post", post.id, post.title));
  }
  if (isAdmin && $("#notice-toggle-button")) {
    $("#notice-toggle-button").addEventListener("click", () => toggleNotice(post.id, post.is_notice));
  }
  if (ownPost) $("#own-delete").addEventListener("click", () => deleteOwnPost(post.id));

  // 배추를 방금 준 경우 버튼에 짧은 팝 애니메이션 적용
  if (justCabbagedPostId === post.id) {
    const btn = $("#cabbage-button");
    if (btn) {
      btn.classList.add("cabbage-pop");
      setTimeout(() => btn.classList.remove("cabbage-pop"), 450);
    }
    justCabbagedPostId = null;
  }

  const { data: comments, error: commentError } = await supabase
    .from("school_community_comments")
    .select("*")
    .eq("post_id", post.id)
    .order("created_at");
  if (commentError) return toast(`댓글을 불러오지 못했습니다: ${commentError.message}`);

  await ensureCabbageTotals((comments || []).map((c) => c.author_id));

  $("#comment-count").textContent = comments.length;
  const { topLevel, repliesByParent } = buildCommentTree(comments || []);
  $("#comment-list").innerHTML = topLevel.length
    ? topLevel.map((c) => renderCommentNode(c, repliesByParent)).join("")
    : `<div class="comment" style="color:var(--muted); font-size:14px;">작성된 첫 댓글이 없습니다.</div>`;
}

async function toggleNotice(postId, current) {
  const { error } = await supabase.from("school_community_posts").update({ is_notice: !current }).eq("id", postId);
  if (error) return toast(`공지 설정 실패: ${error.message}`);
  toast(!current ? "📌 상단에 고정되었습니다." : "고정이 해제되었습니다.");

  if (!current && currentUser) {
    const { data: post } = await supabase.from("school_community_posts").select("title").eq("id", postId).maybeSingle();
    const { data: profiles } = await supabase.from("school_community_profiles").select("id").neq("id", currentUser.id);
    if (post && profiles) {
      for (const p of profiles) {
        await createNotification(p.id, "notice", `📌 새 공지: ${post.title}`, "post", postId);
      }
    }
  }

  if (selectedPostId === postId) loadDetail();
  if (currentPageName === "boards") loadPosts();
  if (adminPostSearchCache.length) renderAdminPostSearchResult();
}

// ------------------------------------------------------------
// 🥬 배추 게시판 / 랭킹 (일간·주간·월간 TOP 5)
// ------------------------------------------------------------

function cabbagePeriodStartDate(period) {
  const now = new Date();
  if (period === "weekly") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (period === "monthly") {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    return d;
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function loadCabbageRanking() {
  const list = $("#cabbage-rank-list");
  if (!list) return;
  list.innerHTML = `<div class="cabbage-rank-empty">불러오는 중입니다...</div>`;

  const startDate = cabbagePeriodStartDate(currentCabbagePeriod);

  const { data: recs, error } = await supabase
    .from("school_community_cabbage_recommends")
    .select("post_id, created_at")
    .gte("created_at", startDate.toISOString());

  if (error) {
    list.innerHTML = `<div class="cabbage-rank-empty">랭킹을 불러오지 못했습니다.</div>`;
    return toast(`배추 랭킹 조회 실패: ${error.message}`);
  }

  const counts = {};
  (recs || []).forEach((r) => { counts[r.post_id] = (counts[r.post_id] || 0) + 1; });

  const topIds = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);

  if (!topIds.length) {
    list.innerHTML = `<div class="cabbage-rank-empty">해당 기간에 배추를 받은 게시글이 없습니다.</div>`;
    return;
  }

  const { data: posts, error: postsError } = await supabase
    .from("school_community_posts")
    .select("id,title,author_id,author_nickname,comment_count,board_type")
    .in("id", topIds);

  if (postsError) {
    list.innerHTML = `<div class="cabbage-rank-empty">게시글 정보를 불러오지 못했습니다.</div>`;
    return toast(`게시글 정보를 불러오지 못했습니다: ${postsError.message}`);
  }

  const medals = ["🥇", "🥈", "🥉", "4위", "5위"];

  list.innerHTML = topIds.map((id, idx) => {
    const post = posts.find((p) => p.id === id);
    if (!post) return "";
    return `
      <button class="cabbage-rank-row rank-${idx + 1}" data-post-id="${post.id}" type="button">
        <span class="cabbage-rank-medal">${medals[idx]}</span>
        <span class="cabbage-rank-info">
          <span class="cabbage-rank-title">${escapeHtml(post.title)}</span>
          <span class="cabbage-rank-author">${escapeHtml(post.author_nickname)}</span>
        </span>
        <span class="cabbage-rank-stats">
          <span class="cabbage-rank-count">🥬 배추 ${counts[id]}개</span>
          <span class="cabbage-rank-comments">💬 ${post.comment_count || 0}</span>
        </span>
      </button>
    `;
  }).join("");

  // TOP5 진입 알림 (내 게시글이 새로 진입한 경우)
  if (currentUser) {
    for (const id of topIds) {
      const post = posts.find((p) => p.id === id);
      if (!post || post.author_id !== currentUser.id) continue;
      const { data: existing } = await supabase
        .from("school_community_notifications")
        .select("id")
        .eq("user_id", currentUser.id)
        .eq("type", "top5")
        .eq("target_id", post.id)
        .gte("created_at", new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString())
        .maybeSingle();
      if (!existing) {
        await createNotification(currentUser.id, "top5", `내 게시글이 ${periodLabel(currentCabbagePeriod)} 배추 TOP5에 진입했습니다!`, "post", post.id);
      }
    }
  }
}

// ------------------------------------------------------------
// 신고 시스템 (게시글 / DM 메시지)
// ------------------------------------------------------------

function openReportModal(type, targetId, excerpt) {
  if (!currentUser) return toast("로그인이 필요합니다.");
  activeReportTarget = { type, targetId, excerpt: (excerpt || "").slice(0, 200) };
  $("#report-reason").value = "욕설/비하";
  $("#report-detail").value = "";
  $("#report-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeReportModal() {
  $("#report-modal").hidden = true;
  document.body.style.overflow = "";
  activeReportTarget = null;
}

$("#report-cancel").addEventListener("click", closeReportModal);

$("#report-modal").addEventListener("click", (event) => {
  if (event.target === $("#report-modal")) closeReportModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#report-modal").hidden) closeReportModal();
});

$("#report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !activeReportTarget) return;

  const { error } = await supabase.from("school_community_reports").insert({
    reporter_id: currentUser.id,
    report_type: activeReportTarget.type,
    target_id: activeReportTarget.targetId,
    target_excerpt: activeReportTarget.excerpt,
    reason: $("#report-reason").value,
    detail: $("#report-detail").value.trim() || null
  });

  if (error) return toast(`신고 접수 실패: ${error.message}`);

  toast("신고가 접수되었습니다. 운영진이 확인 후 처리합니다.");
  closeReportModal();
});

// ------------------------------------------------------------
// DM(1:1 채팅) 시스템
// ------------------------------------------------------------

async function startConversationAndOpen(otherId, otherNickname) {
  if (!currentUser || !currentProfile) return toast("로그인이 필요합니다.");
  if (otherId === currentUser.id) return toast("자기 자신에게는 메시지를 보낼 수 없습니다.");

  const { data: conversationId, error } = await supabase.rpc("start_conversation", {
    other_user: otherId,
    my_nickname: currentProfile.nickname,
    other_nickname: otherNickname
  });

  if (error) return toast(`대화를 시작하지 못했습니다: ${error.message}`);

  myConversationIds.add(conversationId);
  activeConversationId = conversationId;
  activeChatPartner = { id: otherId, nickname: otherNickname };
  $("#dm-search-input").value = "";
  $("#dm-search-results").hidden = true;
  showPage("chat");
}

async function loadConversations() {
  if (!currentUser) return;

  const { data: convs, error } = await supabase
    .from("school_community_conversations")
    .select("*")
    .or(`user1.eq.${currentUser.id},user2.eq.${currentUser.id}`)
    .order("last_message_at", { ascending: false });

  if (error) return toast(`대화 목록을 불러오지 못했습니다: ${error.message}`);

  myConversationIds = new Set((convs || []).map((c) => c.id));

  const { data: unreadRows } = await supabase
    .from("school_community_messages")
    .select("conversation_id")
    .neq("sender_id", currentUser.id)
    .eq("is_read", false);

  const unreadCounts = {};
  (unreadRows || []).forEach((row) => {
    unreadCounts[row.conversation_id] = (unreadCounts[row.conversation_id] || 0) + 1;
  });

  const list = $("#dm-conversation-list");
  if (!list) return;

  conversationsCache = convs.map((conv) => {
    const isUser1 = conv.user1 === currentUser.id;
    return {
      ...conv,
      partnerId: isUser1 ? conv.user2 : conv.user1,
      partnerNickname: isUser1 ? conv.user2_nickname : conv.user1_nickname
    };
  });

  await ensureCabbageTotals(conversationsCache.map((c) => c.partnerId));

  list.innerHTML = conversationsCache.length ? conversationsCache.map((conv) => {
    const unread = unreadCounts[conv.id] || 0;
    return `
      <button class="conversation-row" data-conversation-id="${conv.id}" type="button">
        <span class="conversation-name author-link" data-user-id="${conv.partnerId}">${escapeHtml(conv.partnerNickname)} ${cabbageBadge(conv.partnerId)}</span>
        <span class="conversation-preview">${escapeHtml(conv.last_message || "대화를 시작해보세요.")}</span>
        <span class="conversation-time">${time(conv.last_message_at)}</span>
        ${unread ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
      </button>
    `;
  }).join("") : `<div class="post-row" style="text-align:center; color:var(--muted);">아직 대화가 없습니다. 위에서 학우를 검색해 대화를 시작해보세요.</div>`;
}

$("#dm-search-input").addEventListener("input", (event) => {
  clearTimeout(dmSearchDebounce);
  const query = event.target.value.trim();
  const resultsBox = $("#dm-search-results");
  if (!query) {
    resultsBox.hidden = true;
    resultsBox.innerHTML = "";
    return;
  }
  dmSearchDebounce = setTimeout(async () => {
    // 익명성 보호: 닉네임으로만 검색하며, 실명/학번/생년월일은 절대 조회하지 않습니다.
    const { data, error } = await supabase
      .from("school_community_searchable_profiles")
      .select("id,nickname")
      .ilike("nickname", `%${query}%`)
      .neq("id", currentUser?.id || "")
      .limit(10);

    if (error) return toast(`검색 실패: ${error.message}`);

    searchResultsCache = data || [];
    await ensureCabbageTotals(searchResultsCache.map((p) => p.id));
    resultsBox.hidden = false;
    resultsBox.innerHTML = searchResultsCache.length ? searchResultsCache.map((profile) => `
      <button class="dm-search-result-row" data-user-id="${profile.id}" type="button">
        <span>${escapeHtml(profile.nickname)} ${cabbageBadge(profile.id)}</span>
        <span class="dm-search-start">대화 시작 →</span>
      </button>
    `).join("") : `<div class="dm-search-empty">일치하는 닉네임이 없습니다.</div>`;
  }, 300);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#dm-search-input") && !event.target.closest("#dm-search-results")) {
    const resultsBox = $("#dm-search-results");
    if (resultsBox) { resultsBox.hidden = true; }
  }
});

async function loadChatMessages() {
  if (!activeConversationId || !activeChatPartner) return showPage("dms");
  await ensureCabbageTotals([activeChatPartner.id]);
  $("#chat-partner-name").innerHTML = `${escapeHtml(activeChatPartner.nickname)} ${cabbageBadge(activeChatPartner.id)}`;
  $("#chat-partner-name").dataset.userId = activeChatPartner.id;

  const messages = await fetchChatMessages();
  renderChatMessages(messages);
  await markMessagesRead(messages);
  subscribeToChat();
}

async function fetchChatMessages() {
  const { data, error } = await supabase
    .from("school_community_messages")
    .select("*")
    .eq("conversation_id", activeConversationId)
    .order("created_at", { ascending: true });
  if (error) { toast(`메시지를 불러오지 못했습니다: ${error.message}`); return []; }
  return data || [];
}

function renderChatMessages(messages) {
  const box = $("#chat-messages");
  if (!box) return;

  chatMessagesCache = messages;
  let lastDateLabel = "";
  box.innerHTML = messages.length ? messages.map((msg) => {
    const isMine = msg.sender_id === currentUser.id;
    const dateLabel = new Date(msg.created_at).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
    let dateDivider = "";
    if (dateLabel !== lastDateLabel) {
      dateDivider = `<div class="chat-date-divider"><span>${dateLabel}</span></div>`;
      lastDateLabel = dateLabel;
    }
    const timeLabel = new Date(msg.created_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    const actionBtn = isMine
      ? `<button class="chat-delete-btn" data-message-id="${msg.id}" type="button" aria-label="메시지 삭제">🗑</button>`
      : `<button class="chat-report-btn" data-message-id="${msg.id}" type="button" aria-label="메시지 신고">🚩</button>`;
    return `
      ${dateDivider}
      <div class="chat-bubble-row ${isMine ? "mine" : "theirs"}">
        <div class="chat-bubble">${escapeHtml(msg.content)}</div>
        <span class="chat-bubble-time">${timeLabel}</span>
        ${actionBtn}
      </div>
    `;
  }).join("") : `<div class="chat-empty">첫 메시지를 보내보세요.</div>`;

  document.querySelectorAll("#chat-messages .chat-report-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const msg = chatMessagesCache.find((m) => m.id === btn.dataset.messageId);
      if (msg) openReportModal("message", msg.id, msg.content);
    });
  });

  document.querySelectorAll("#chat-messages .chat-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("이 메시지를 삭제하시겠습니까?")) return;
      const { error } = await supabase.from("school_community_messages").delete().eq("id", btn.dataset.messageId);
      if (error) return toast(`메시지 삭제 실패: ${error.message}`);
      const refreshed = await fetchChatMessages();
      renderChatMessages(refreshed);
    });
  });

  box.scrollTop = box.scrollHeight;
}

async function markMessagesRead(messages) {
  const unreadIds = messages
    .filter((msg) => msg.sender_id !== currentUser.id && !msg.is_read)
    .map((msg) => msg.id);
  if (!unreadIds.length) return;
  await supabase.from("school_community_messages").update({ is_read: true }).in("id", unreadIds);
}

function subscribeToChat() {
  unsubscribeFromChat();
  chatRealtimeChannel = supabase
    .channel(`chat-${activeConversationId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "school_community_messages",
      filter: `conversation_id=eq.${activeConversationId}`
    }, async (payload) => {
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
      if (payload.eventType === "INSERT" && payload.new.sender_id !== currentUser.id) {
        await markMessagesRead(messages);
      }
    })
    .subscribe();
}

function unsubscribeFromChat() {
  if (chatRealtimeChannel) {
    supabase.removeChannel(chatRealtimeChannel);
    chatRealtimeChannel = null;
  }
}

function autoResizeChatInput() {
  const el = $("#chat-input");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

$("#chat-input").addEventListener("input", autoResizeChatInput);

$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !currentProfile || !activeConversationId) return;
  const input = $("#chat-input");
  const content = input.value.trim();
  if (!content) return;

  input.value = "";
  autoResizeChatInput();

  const { error } = await supabase.from("school_community_messages").insert({
    conversation_id: activeConversationId,
    sender_id: currentUser.id,
    sender_nickname: currentProfile.nickname,
    content
  });

  if (error) {
    toast(`메시지 전송 실패: ${error.message}`);
  } else if (activeChatPartner) {
    createNotification(activeChatPartner.id, "dm", `${currentProfile.nickname}님이 쪽지를 보냈습니다.`, "dm", activeConversationId);
  }
});

// ------------------------------------------------------------
// 회원가입 (학생 / 선생님)
// ------------------------------------------------------------

$("#signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const grade = $("#signup-grade").value;
  const klass = $("#signup-class").value;
  const numRaw = $("#signup-number").value.trim();
  const name = $("#signup-name").value.trim();
  const nickname = $("#signup-nickname").value.trim();
  const password = $("#signup-password").value;

  const studentId = `${grade}${klass.padStart(2, "0")}${numRaw.padStart(2, "0")}`;
  const computedEmail = studentEmail(studentId);

  const { data, error } = await supabase.auth.signUp({
    email: computedEmail,
    password,
    options: {
      data: {
        student_id: studentId,
        name: name,
        nickname: nickname,
        role: "student",
        grade: parseInt(grade, 10),
        class: parseInt(klass, 10),
        number: parseInt(numRaw, 10)
      }
    }
  });

  if (error) return toast(`회원가입 실패: ${error.message}`);

  if (data?.user) {
    await supabase.from("school_community_profiles").upsert({
      id: data.user.id,
      nickname,
      role: "student",
      student_id: studentId,
      name
    }, { onConflict: "id" });

    currentUser = data.user;
    currentProfile = { id: data.user.id, nickname, role: "student" };
    updateHeader();
  }
  toast("회원가입이 완료되었습니다!");
  $("#signup-form").reset();
});

$("#teacher-signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = $("#teacher-signup-name").value.trim();
  const birth = $("#teacher-signup-birth").value;
  const nickname = $("#teacher-signup-nickname").value.trim();
  const password = $("#teacher-signup-password").value;

  const computedEmail = teacherEmail(name, birth);

  const { data, error } = await supabase.auth.signUp({
    email: computedEmail,
    password,
    options: {
      data: { name, birth_date: birth, nickname, role: "teacher" }
    }
  });

  if (error) return toast(`회원가입 실패: ${error.message}`);

  if (data?.user) {
    await supabase.from("school_community_profiles").upsert({
      id: data.user.id,
      nickname,
      role: "teacher",
      name,
      birth_date: birth
    }, { onConflict: "id" });

    currentUser = data.user;
    currentProfile = { id: data.user.id, nickname, role: "teacher" };
    updateHeader();
  }
  toast("회원가입이 완료되었습니다!");
  $("#teacher-signup-form").reset();
});

async function toggleCabbage(postId, alreadyRecommended) {
  if (!currentUser) return toast("로그인이 필요합니다.");
  const result = alreadyRecommended
    ? await supabase.from("school_community_cabbage_recommends").delete().eq("post_id", postId).eq("user_id", currentUser.id)
    : await supabase.from("school_community_cabbage_recommends").insert({ post_id: postId, user_id: currentUser.id });
  if (result.error) return toast(`추천 연산 처리 실패: ${result.error.message}`);

  if (!alreadyRecommended) {
    justCabbagedPostId = postId;
    const { data: post } = await supabase.from("school_community_posts").select("author_id").eq("id", postId).maybeSingle();
    if (post) {
      cabbageTotalCache.delete(post.author_id);
      if (post.author_id !== currentUser.id) {
        createNotification(post.author_id, "cabbage", `${currentProfile.nickname}님이 회원님의 글에 배추를 주었습니다.`, "post", postId);
      }
    }
  }
  await loadDetail();
}

async function deleteOwnPost(postId) {
  if (!confirm("이 글을 영구 삭제하시겠습니까?")) return;
  const { error } = await supabase.from("school_community_posts").delete().eq("id", postId);
  if (error) return toast(`삭제 실패: ${error.message}`);
  toast("글이 완전히 삭제되었습니다.");
  showPage("boards");
}

// ------------------------------------------------------------
// 로그인 (학생 / 선생님)
// ------------------------------------------------------------

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { error } = await supabase.auth.signInWithPassword({
    email: studentEmail($("#login-student-id").value),
    password: $("#login-password").value
  });
  if (error) toast("학번 정보 또는 비밀번호를 다시 확인하세요.");
});

$("#teacher-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#teacher-login-name").value.trim();
  const birth = $("#teacher-login-birth").value;
  const { error } = await supabase.auth.signInWithPassword({
    email: teacherEmail(name, birth),
    password: $("#teacher-login-password").value
  });
  if (error) toast("이름, 생년월일 또는 비밀번호를 다시 확인하세요.");
});

$("#logout-button").addEventListener("click", () => { supabase.auth.signOut(); });

$("#write-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !currentProfile) return toast("로그인이 필요합니다.");
  const title = $("#post-title").value.trim();
  const content = $("#post-content").value.trim();
  if (containsBannedWord(title) || containsBannedWord(content)) return toast("사용할 수 없는 단어가 포함되어 있습니다.");
  const { error } = await supabase.from("school_community_posts").insert({
    board_type: $("#post-board").value,
    title,
    content,
    author_id: currentUser.id,
    author_nickname: currentProfile.nickname
  });
  if (error) return toast(`글 등록 실패: ${error.message}`);
  currentBoard = $("#post-board").value;
  $("#write-form").reset();
  toast("이야기가 등록되었습니다.");
  showPage("boards");
});

$("#comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !currentProfile) return toast("로그인이 필요합니다.");
  const content = $("#comment-content").value.trim();
  if (containsBannedWord(content)) return toast("사용할 수 없는 단어가 포함되어 있습니다.");
  const { error } = await supabase.from("school_community_comments").insert({
    post_id: selectedPostId,
    author_id: currentUser.id,
    author_nickname: currentProfile.nickname,
    content
  });
  if (error) return toast(`댓글 등록 실패: ${error.message}`);
  $("#comment-form").reset();
  toast("댓글이 등록되었습니다.");

  const { data: post } = await supabase.from("school_community_posts").select("author_id").eq("id", selectedPostId).maybeSingle();
  if (post && post.author_id !== currentUser.id) {
    createNotification(post.author_id, "comment", `${currentProfile.nickname}님이 회원님의 글에 댓글을 남겼습니다.`, "post", selectedPostId);
  }
  loadDetail();
});

// 대댓글(답글) 등록 - 동적으로 삽입되는 .reply-form 위임 처리
document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".reply-form");
  if (!form) return;
  event.preventDefault();
  if (!currentUser || !currentProfile) return toast("로그인이 필요합니다.");

  const parentId = form.dataset.parentId;
  const input = form.querySelector(".reply-input");
  const content = input.value.trim();
  if (!content) return;
  if (containsBannedWord(content)) return toast("사용할 수 없는 단어가 포함되어 있습니다.");

  const { error } = await supabase.from("school_community_comments").insert({
    post_id: selectedPostId,
    author_id: currentUser.id,
    author_nickname: currentProfile.nickname,
    content,
    parent_id: parentId
  });
  if (error) return toast(`답글 등록 실패: ${error.message}`);
  toast("답글이 등록되었습니다.");

  const { data: parentComment } = await supabase.from("school_community_comments").select("author_id").eq("id", parentId).maybeSingle();
  if (parentComment && parentComment.author_id !== currentUser.id) {
    createNotification(parentComment.author_id, "reply", `${currentProfile.nickname}님이 회원님의 댓글에 답글을 남겼습니다.`, "post", selectedPostId);
  }
  loadDetail();
});

document.addEventListener("click", (event) => {
  const page = event.target.dataset.page;
  if (page) { showPage(page); return; }

  const authorLink = event.target.closest(".author-link");
  if (authorLink && authorLink.dataset.userId) {
    openProfile(authorLink.dataset.userId);
    return;
  }

  const replyToggleBtn = event.target.closest(".reply-toggle-btn");
  if (replyToggleBtn) {
    const commentId = replyToggleBtn.dataset.commentId;
    const slot = document.getElementById(`reply-form-${commentId}`);
    if (!slot) return;
    if (slot.innerHTML.trim()) { slot.innerHTML = ""; return; }
    if (!currentUser) return toast("로그인이 필요합니다.");
    slot.innerHTML = `
      <form class="reply-form" data-parent-id="${commentId}">
        <input class="reply-input" placeholder="답글을 입력하세요" required maxlength="500">
        <button type="submit">등록</button>
      </form>
    `;
    return;
  }

  const notifRow = event.target.closest(".notification-row");
  if (notifRow) {
    const id = notifRow.dataset.notificationId;
    const targetType = notifRow.dataset.targetType;
    const targetId = notifRow.dataset.targetId;
    markNotificationRead(id);
    $("#notification-panel").hidden = true;
    if (targetType === "post" && targetId) { selectedPostId = targetId; showPage("detail"); }
    else if (targetType === "dm" && targetId) { openConversationById(targetId); }
    return;
  }

  const profileTabBtn = event.target.closest("#profile-tabs button");
  if (profileTabBtn) {
    profileActiveTab = profileTabBtn.dataset.profileTab;
    document.querySelectorAll("#profile-tabs button").forEach((b) => b.classList.toggle("active", b === profileTabBtn));
    renderProfileTabContent();
    return;
  }

  const profileListRow = event.target.closest(".profile-list-row");
  if (profileListRow && profileListRow.dataset.postId) {
    selectedPostId = profileListRow.dataset.postId;
    showPage("detail");
    return;
  }

  const roleTabBtn = event.target.closest(".role-tab-btn");
  if (roleTabBtn) {
    const area = roleTabBtn.closest(".role-tabs").id.startsWith("login") ? "login" : "signup";
    switchRoleTab(area, roleTabBtn.dataset.roleTab);
    return;
  }

  const board = event.target.dataset.board;
  if (board) {
    currentBoard = board;
    document.querySelectorAll("#board-tabs button").forEach((button) => button.classList.toggle("active", button === event.target));
    loadPosts();
    return;
  }

  const periodBtn = event.target.closest("#cabbage-period-tabs button");
  if (periodBtn) {
    currentCabbagePeriod = periodBtn.dataset.period;
    document.querySelectorAll("#cabbage-period-tabs button").forEach((button) => button.classList.toggle("active", button === periodBtn));
    loadCabbageRanking();
    return;
  }

  const cabbageRankRow = event.target.closest(".cabbage-rank-row");
  if (cabbageRankRow && cabbageRankRow.dataset.postId) {
    selectedPostId = cabbageRankRow.dataset.postId;
    showPage("detail");
    return;
  }

  const postRow = event.target.closest(".post-row-line");
  if (postRow && postRow.dataset.postId) {
    selectedPostId = postRow.dataset.postId;
    showPage("detail");
    return;
  }

  const conversationRow = event.target.closest(".conversation-row");
  if (conversationRow) {
    const conv = conversationsCache.find((c) => c.id === conversationRow.dataset.conversationId);
    if (!conv) return;
    activeConversationId = conv.id;
    activeChatPartner = { id: conv.partnerId, nickname: conv.partnerNickname };
    showPage("chat");
    return;
  }

  const searchResultRow = event.target.closest(".dm-search-result-row");
  if (searchResultRow) {
    const profile = searchResultsCache.find((p) => p.id === searchResultRow.dataset.userId);
    if (profile) startConversationAndOpen(profile.id, profile.nickname);
    return;
  }

  const adminTabBtn = event.target.closest(".admin-tab-btn");
  if (adminTabBtn) {
    switchAdminTab(adminTabBtn.dataset.adminTab);
  }
});

// Shift+T 단축키: 입력 중(Input/Textarea/Select/contenteditable)에는 동작하지 않도록 하고,
// 키를 누르고 있을 때 반복 발화(event.repeat)로 패널이 깜빡이며 재오픈되는 현상을 방지합니다.
document.addEventListener("keydown", (event) => {
  if (event.repeat) return;

  const target = event.target;
  const isTypingContext = !!target && (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
  if (isTypingContext) return;

  if (event.shiftKey && event.key.toLowerCase() === "t") {
    if (!isAdmin) return;
    const panel = $("#admin-panel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) loadReports();
  }
});

function switchAdminTab(tabName) {
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.adminTab === tabName);
  });
  document.querySelectorAll(".admin-tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== `admin-tab-${tabName}`;
  });
  if (tabName === "words") {
    loadBannedWords().then(renderAdminWordList);
  }
}

$("#admin-close").addEventListener("click", () => { $("#admin-panel").hidden = true; });

// ------------------------------------------------------------
// 관리자: 신고 관리
// ------------------------------------------------------------

const REPORT_TYPE_LABEL = { post: "게시물", message: "쪽지" };
const REPORT_STATUS_LABEL = { pending: "대기중", resolved: "처리완료", dismissed: "무시함" };

async function loadReports() {
  if (!isAdmin) return;
  const { data, error } = await supabase
    .from("school_community_reports")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return toast(`신고 목록을 불러오지 못했습니다: ${error.message}`);

  reportsCache = data || [];
  const list = $("#admin-report-list");
  if (!list) return;

  list.innerHTML = reportsCache.length ? reportsCache.map((report) => `
    <div class="admin-report-card status-${report.status}">
      <div class="admin-report-head">
        <span class="admin-report-type">${REPORT_TYPE_LABEL[report.report_type] || report.report_type}</span>
        <span class="admin-report-status">${REPORT_STATUS_LABEL[report.status] || report.status}</span>
      </div>
      <div class="admin-report-reason"><strong>사유:</strong> ${escapeHtml(report.reason)}</div>
      ${report.detail ? `<div class="admin-report-detail">${escapeHtml(report.detail)}</div>` : ""}
      <div class="admin-report-excerpt">${escapeHtml(report.target_excerpt || "(내용 없음)")}</div>
      <div class="admin-report-time">${time(report.created_at)}</div>
      ${report.status === "pending" ? `
        <div class="admin-report-actions">
          <button class="admin-report-resolve" data-report-id="${report.id}" type="button">처리 완료</button>
          <button class="admin-report-delete-target" data-report-id="${report.id}" type="button">대상 삭제</button>
          <button class="admin-report-dismiss" data-report-id="${report.id}" type="button">무시</button>
        </div>
      ` : ""}
    </div>
  `).join("") : `<div class="admin-empty">접수된 신고가 없습니다.</div>`;

  document.querySelectorAll(".admin-report-resolve").forEach((btn) => {
    btn.addEventListener("click", () => updateReportStatus(btn.dataset.reportId, "resolved"));
  });
  document.querySelectorAll(".admin-report-dismiss").forEach((btn) => {
    btn.addEventListener("click", () => updateReportStatus(btn.dataset.reportId, "dismissed"));
  });
  document.querySelectorAll(".admin-report-delete-target").forEach((btn) => {
    btn.addEventListener("click", () => deleteReportedTarget(btn.dataset.reportId));
  });
}

async function updateReportStatus(reportId, status) {
  const { error } = await supabase.from("school_community_reports").update({ status }).eq("id", reportId);
  if (error) return toast(`신고 처리 실패: ${error.message}`);
  toast(status === "resolved" ? "신고를 처리 완료로 표시했습니다." : "신고를 무시 처리했습니다.");
  loadReports();
}

async function deleteReportedTarget(reportId) {
  const report = reportsCache.find((r) => r.id === reportId);
  if (!report) return;
  if (!confirm("신고된 대상을 삭제하고 신고를 처리 완료로 표시하시겠습니까?")) return;

  const tableByType = {
    post: "school_community_posts",
    message: "school_community_messages"
  };
  const table = tableByType[report.report_type];
  if (!table) return toast("알 수 없는 신고 유형입니다.");

  const { error: deleteError } = await supabase.from(table).delete().eq("id", report.target_id);
  if (deleteError) return toast(`대상 삭제 실패: ${deleteError.message}`);

  await updateReportStatus(reportId, "resolved");
  toast("신고된 대상이 삭제되었습니다.");
  if (report.report_type === "post" && selectedPostId === report.target_id) showPage("boards");
}

// ------------------------------------------------------------
// 관리자: 계정 관리 (학번/실명 검색 → 정지·권한·삭제·배추 초기화·강제 로그아웃)
// ------------------------------------------------------------

$("#admin-account-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("#admin-account-search-input").value.trim();
  if (!query) return;

  const { data, error } = await supabase
    .from("school_community_profiles")
    .select("id,nickname,role,student_id,name,is_banned")
    .or(`student_id.eq.${query},name.eq.${query}`)
    .limit(1)
    .maybeSingle();

  if (error) return toast(`검색 실패: ${error.message}`);
  if (!data) {
    adminAccountResult = null;
    $("#admin-account-result").innerHTML = `<div class="admin-empty">일치하는 계정이 없습니다.</div>`;
    return;
  }

  adminAccountResult = data;
  await renderAdminAccountResult();
});

async function renderAdminAccountResult() {
  const box = $("#admin-account-result");
  if (!box || !adminAccountResult) return;
  const profile = adminAccountResult;

  const { data: posts } = await supabase.from("school_community_posts").select("id,title,cabbage_count").eq("author_id", profile.id);
  const { data: comments } = await supabase.from("school_community_comments").select("id,content").eq("author_id", profile.id);

  box.innerHTML = `
    <div class="admin-account-card">
      <div><strong>${escapeHtml(profile.nickname)}</strong> (${profile.role === "teacher" ? "선생님" : profile.role === "admin" ? "관리자" : "학생"})</div>
      <div class="admin-account-sub">식별자: ${escapeHtml(profile.student_id || profile.name || "-")}</div>
      <div class="admin-account-sub">상태: ${profile.is_banned ? "🚫 정지됨" : "정상"}</div>
      <div class="admin-account-actions">
        <button id="admin-toggle-ban" type="button">${profile.is_banned ? "정지 해제" : "계정 정지"}</button>
        <button id="admin-toggle-role" type="button">${profile.role === "admin" ? "관리자 권한 해제" : "관리자 권한 부여"}</button>
        <button id="admin-force-logout" type="button">강제 로그아웃</button>
      </div>

      <h4>작성 게시글 (${(posts || []).length})</h4>
      <div class="admin-account-list">
        ${(posts || []).map((p) => `
          <div class="admin-account-row">
            <span>${escapeHtml(p.title)}</span>
            <span class="admin-account-row-btns">
              <input type="number" min="0" class="admin-cabbage-input" data-post-id="${p.id}" value="${p.cabbage_count}">
              <button class="admin-set-cabbage" data-post-id="${p.id}" type="button">설정</button>
              <button class="admin-reset-cabbage" data-post-id="${p.id}" type="button">초기화</button>
              <button class="admin-delete-post-inline" data-post-id="${p.id}" type="button">삭제</button>
            </span>
          </div>
        `).join("") || `<div class="admin-empty">작성한 게시글이 없습니다.</div>`}
      </div>

      <h4>작성 댓글 (${(comments || []).length})</h4>
      <div class="admin-account-list">
        ${(comments || []).map((c) => `
          <div class="admin-account-row">
            <span>${escapeHtml(c.content.slice(0, 40))}</span>
            <span class="admin-account-row-btns">
              <button class="admin-delete-comment-inline" data-comment-id="${c.id}" type="button">삭제</button>
            </span>
          </div>
        `).join("") || `<div class="admin-empty">작성한 댓글이 없습니다.</div>`}
      </div>
    </div>
  `;

  $("#admin-toggle-ban").addEventListener("click", async () => {
    const { error } = await supabase.from("school_community_profiles").update({ is_banned: !profile.is_banned }).eq("id", profile.id);
    if (error) return toast(`처리 실패: ${error.message}`);
    toast(!profile.is_banned ? "계정을 정지했습니다." : "정지를 해제했습니다.");
    adminAccountResult.is_banned = !profile.is_banned;
    renderAdminAccountResult();
  });

  $("#admin-toggle-role").addEventListener("click", async () => {
    const nextRole = profile.role === "admin" ? "student" : "admin";
    const { error } = await supabase.from("school_community_profiles").update({ role: nextRole }).eq("id", profile.id);
    if (error) return toast(`처리 실패: ${error.message}`);
    toast(nextRole === "admin" ? "관리자 권한을 부여했습니다." : "관리자 권한을 해제했습니다.");
    adminAccountResult.role = nextRole;
    renderAdminAccountResult();
  });

  $("#admin-force-logout").addEventListener("click", async () => {
    if (!confirm("이 사용자를 강제 로그아웃 처리하시겠습니까?")) return;
    const { error } = await supabase.from("school_community_profiles").update({ force_logout_at: new Date().toISOString() }).eq("id", profile.id);
    if (error) return toast(`강제 로그아웃 처리 실패: ${error.message}`);
    toast("강제 로그아웃이 요청되었습니다. (해당 사용자 접속 시 자동 로그아웃됩니다)");
  });

  document.querySelectorAll(".admin-set-cabbage").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const postId = btn.dataset.postId;
      const input = document.querySelector(`.admin-cabbage-input[data-post-id="${postId}"]`);
      const value = Math.max(0, parseInt(input.value, 10) || 0);
      const { error } = await supabase.from("school_community_posts").update({ cabbage_count: value }).eq("id", postId);
      if (error) return toast(`배추 개수 설정 실패: ${error.message}`);
      toast("배추 개수가 수정되었습니다.");
      cabbageTotalCache.delete(profile.id);
      renderAdminAccountResult();
    });
  });

  document.querySelectorAll(".admin-reset-cabbage").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const postId = btn.dataset.postId;
      const { error: delError } = await supabase.from("school_community_cabbage_recommends").delete().eq("post_id", postId);
      if (delError) return toast(`배추 초기화 실패: ${delError.message}`);
      const { error: updateError } = await supabase.from("school_community_posts").update({ cabbage_count: 0 }).eq("id", postId);
      if (updateError) return toast(`배추 초기화 실패: ${updateError.message}`);
      toast("배추 추천이 초기화되었습니다.");
      cabbageTotalCache.delete(profile.id);
      renderAdminAccountResult();
    });
  });

  document.querySelectorAll(".admin-delete-post-inline").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("이 게시글을 삭제하시겠습니까?")) return;
      const { error } = await supabase.from("school_community_posts").delete().eq("id", btn.dataset.postId);
      if (error) return toast(`삭제 실패: ${error.message}`);
      toast("게시글이 삭제되었습니다.");
      renderAdminAccountResult();
    });
  });

  document.querySelectorAll(".admin-delete-comment-inline").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("이 댓글을 삭제하시겠습니까?")) return;
      const { error } = await supabase.from("school_community_comments").delete().eq("id", btn.dataset.commentId);
      if (error) return toast(`삭제 실패: ${error.message}`);
      toast("댓글이 삭제되었습니다.");
      renderAdminAccountResult();
    });
  });
}

// ------------------------------------------------------------
// 관리자: 게시글 관리 (제목 검색 → 수정/삭제/고정)
// ------------------------------------------------------------

$("#admin-post-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("#admin-post-search-input").value.trim();
  if (!query) return;
  const { data, error } = await supabase
    .from("school_community_posts")
    .select("*")
    .ilike("title", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return toast(`검색 실패: ${error.message}`);
  adminPostSearchCache = data || [];
  renderAdminPostSearchResult();
});

function renderAdminPostSearchResult() {
  const box = $("#admin-post-search-result");
  if (!box) return;
  box.innerHTML = adminPostSearchCache.length ? adminPostSearchCache.map((p) => `
    <div class="admin-post-edit-card" data-post-id="${p.id}">
      <div class="admin-account-sub">${escapeHtml(p.board_type)} · ${escapeHtml(p.author_nickname)} · ${p.is_notice ? "📌 공지" : "일반"}</div>
      <input class="admin-post-edit-title" type="text" value="${escapeHtml(p.title)}" maxlength="60">
      <textarea class="admin-post-edit-content" maxlength="1500">${escapeHtml(p.content)}</textarea>
      <div class="admin-account-row-btns">
        <button class="admin-post-save" data-post-id="${p.id}" type="button">수정 저장</button>
        <button class="admin-post-pin-toggle" data-post-id="${p.id}" data-current="${p.is_notice}" type="button">${p.is_notice ? "고정 해제" : "📌 상단 고정"}</button>
        <button class="admin-post-delete" data-post-id="${p.id}" type="button">삭제</button>
      </div>
    </div>
  `).join("") : `<div class="admin-empty">검색 결과가 없습니다.</div>`;

  document.querySelectorAll(".admin-post-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".admin-post-edit-card");
      const title = card.querySelector(".admin-post-edit-title").value.trim();
      const content = card.querySelector(".admin-post-edit-content").value.trim();
      if (containsBannedWord(title) || containsBannedWord(content)) return toast("사용할 수 없는 단어가 포함되어 있습니다.");
      const { error } = await supabase.from("school_community_posts").update({ title, content }).eq("id", btn.dataset.postId);
      if (error) return toast(`수정 실패: ${error.message}`);
      toast("게시글이 수정되었습니다.");
      if (selectedPostId === btn.dataset.postId) loadDetail();
      if (currentPageName === "boards") loadPosts();
    });
  });
  document.querySelectorAll(".admin-post-pin-toggle").forEach((btn) => {
    btn.addEventListener("click", () => toggleNotice(btn.dataset.postId, btn.dataset.current === "true"));
  });
  document.querySelectorAll(".admin-post-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("이 게시글을 삭제하시겠습니까?")) return;
      const { error } = await supabase.from("school_community_posts").delete().eq("id", btn.dataset.postId);
      if (error) return toast(`삭제 실패: ${error.message}`);
      toast("게시글이 삭제되었습니다.");
      adminPostSearchCache = adminPostSearchCache.filter((p) => p.id !== btn.dataset.postId);
      renderAdminPostSearchResult();
      if (selectedPostId === btn.dataset.postId) showPage("boards");
    });
  });
}

// ------------------------------------------------------------
// 관리자: 금칙어 관리
// ------------------------------------------------------------

$("#admin-word-add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const word = $("#admin-word-input").value.trim();
  if (!word) return;
  const { error } = await supabase.from("school_community_banned_words").insert({ word });
  if (error) return toast(`금칙어 추가 실패: ${error.message}`);
  toast("금칙어가 추가되었습니다.");
  $("#admin-word-add-form").reset();
  await loadBannedWords();
  renderAdminWordList();
});

function renderAdminWordList() {
  const box = $("#admin-word-list");
  if (!box) return;
  box.innerHTML = bannedWordsCache.length ? bannedWordsCache.map((w) => `
    <div class="admin-account-row">
      <span>${escapeHtml(w.word)}</span>
      <span class="admin-account-row-btns">
        <button class="admin-word-delete" data-word-id="${w.id}" type="button">삭제</button>
      </span>
    </div>
  `).join("") : `<div class="admin-empty">등록된 금칙어가 없습니다.</div>`;

  document.querySelectorAll(".admin-word-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { error } = await supabase.from("school_community_banned_words").delete().eq("id", btn.dataset.wordId);
      if (error) return toast(`삭제 실패: ${error.message}`);
      toast("금칙어가 삭제되었습니다.");
      await loadBannedWords();
      renderAdminWordList();
    });
  });
}

// ------------------------------------------------------------
// 관리자: 기존 UUID 직접 삭제 (유지)
// ------------------------------------------------------------

$("#admin-delete-post").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { error } = await supabase.from("school_community_posts").delete().eq("id", $("#admin-post-id").value.trim());
  if (error) return toast(`관리자 삭제 처리 실패: ${error.message}`);
  toast("운영자 권한으로 강제 삭제되었습니다.");
  $("#admin-delete-post").reset();
  showPage("boards");
});

$("#admin-delete-comment").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { error } = await supabase.from("school_community_comments").delete().eq("id", $("#admin-comment-id").value.trim());
  if (error) return toast(`관리자 댓글 삭제 처리 실패: ${error.message}`);
  toast("운영자 권한으로 댓글이 강제 삭제되었습니다.");
  $("#admin-delete-comment").reset();
  if (selectedPostId) loadDetail();
});

// ------------------------------------------------------------
// 세션 관리
// ------------------------------------------------------------

async function setSession(session) {
  currentUser = session?.user || null;

  if (currentUser) {
    const { data, error } = await supabase.from("school_community_profiles").select("id,nickname,role,is_banned").eq("id", currentUser.id).maybeSingle();
    if (error) {
      toast("인증 동기화 실패");
      await supabase.auth.signOut();
      return;
    }
    if (data?.is_banned) {
      toast("정지된 계정입니다. 관리자에게 문의하세요.");
      await supabase.auth.signOut();
      return;
    }
    if (data) {
      currentProfile = data;
      isAdmin = data.role === "admin";
    }
    await refreshMyConversationIds();
    subscribeGlobalDmBadge();
    subscribeForceLogout();
    await loadNotifications();
    subscribeNotifications();
  } else {
    currentProfile = null;
    isAdmin = false;
    myConversationIds = new Set();
    notificationsCache = [];
    unsubscribeGlobalDmBadge();
    unsubscribeForceLogout();
    unsubscribeNotifications();
    setDmBadge(false);
    updateNotificationBadge();
  }
  updateHeader();
  showPage(currentUser ? "boards" : "home");
}

await loadBannedWords();

const { data: { session } } = await supabase.auth.getSession();
await setSession(session);
supabase.auth.onAuthStateChange((_event, newSession) => { setSession(newSession); });