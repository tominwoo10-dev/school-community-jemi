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
    $("#current-user").textContent = currentProfile ? `${currentProfile.nickname} 님` : "정보 연동 중..";
  } else {
    $("#guest-nav").style.display = "flex";
    $("#member-nav").style.display = "none";
    $("#current-user").textContent = "";
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
// 페이지 라우팅
// ------------------------------------------------------------

function showPage(name) {
  if (["boards", "write", "detail", "dms", "chat"].includes(name) && !currentUser) {
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
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------
// 게시판 (디시인사이드 스타일 한 줄 리스트 + 공지/개념글)
// ------------------------------------------------------------

function renderPostRow(post, isHot) {
  const badges = `${post.is_notice ? `<span class="tag-notice">공지</span>` : ""}${isHot ? `<span class="tag-hot">개념</span>` : ""}`;
  return `
    <button class="post-row-line${post.is_notice ? " is-notice" : ""}" data-post-id="${post.id}" type="button">
      <span class="col-title">${badges}${escapeHtml(post.title)}</span>
      <span class="col-author">${escapeHtml(post.author_nickname)}</span>
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

async function loadDetail() {
  if (!selectedPostId) return;

  // 증가 차단 레이스방지 RPC 호출
  await supabase.rpc("increment_view_count", { post_id: selectedPostId });

  const { data: post, error } = await supabase.from("school_community_posts").select("*").eq("id", selectedPostId).single();
  if (error) { toast("게시글을 찾을 수 없거나 이미 삭제 처리되었습니다."); return showPage("boards"); }

  const { data: myCabbage } = await supabase.from("school_community_cabbage_recommends").select("post_id").eq("post_id", post.id).maybeSingle();
  const ownPost = currentUser && post.author_id === currentUser.id;
  const dmBtnHtml = (!ownPost && currentUser) ? `<button class="text-button" id="btn-open-dm" type="button" style="font-size:12px; margin-left:8px;">✉ 쪽지 보내기</button>` : "";

  const postDetail = $("#post-detail");
  if (!postDetail) return;

  const badges = `${post.is_notice ? `<span class="tag-notice">공지</span>` : ""}`;

  postDetail.innerHTML = `
    <span class="badge">${post.board_type}</span>
    <h1>${badges}${escapeHtml(post.title)}</h1>
    <div class="meta">${escapeHtml(post.author_nickname)}${dmBtnHtml} · 👀 조회 ${post.view_count || 0} · ${time(post.created_at)}</div>
    <div class="detail-content">${escapeHtml(post.content)}</div>
    <div class="actions">
      <button class="cabbage" id="cabbage-button" type="button">${myCabbage ? "🥬 배추 추천 취소" : "🥬 배추 추천"} ${post.cabbage_count}</button>
      <span class="action-right">
        ${!ownPost ? `<button class="report-btn" id="report-post-button" type="button">🚩 신고</button>` : ""}
        ${isAdmin ? `<button class="notice-toggle-btn" id="notice-toggle-button" type="button">${post.is_notice ? "공지 해제" : "공지로 등록"}</button>` : ""}
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

  const { data: comments, error: commentError } = await supabase.from("school_community_comments").select("*").eq("post_id", post.id).order("created_at");
  if (commentError) return toast(`댓글을 불러오지 못했습니다: ${commentError.message}`);

  $("#comment-count").textContent = comments.length;
  $("#comment-list").innerHTML = comments.length ? comments.map((comment) => `
    <div class="comment">
      <strong>${escapeHtml(comment.author_nickname)}</strong>
      <span class="meta"> · ${time(comment.created_at)}</span>
      <p>${escapeHtml(comment.content)}</p>
    </div>
  `).join("") : `<div class="comment" style="color:var(--muted); font-size:14px;">작성된 첫 댓글이 없습니다.</div>`;
}

async function toggleNotice(postId, current) {
  const { error } = await supabase.from("school_community_posts").update({ is_notice: !current }).eq("id", postId);
  if (error) return toast(`공지 설정 실패: ${error.message}`);
  toast(!current ? "공지로 등록되었습니다." : "공지가 해제되었습니다.");
  loadDetail();
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

// 오버레이 배경(모달 바깥) 클릭 시에도 닫히도록 처리
$("#report-modal").addEventListener("click", (event) => {
  if (event.target === $("#report-modal")) closeReportModal();
});

// Esc 키로도 신고 모달을 닫을 수 있도록 처리
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

  list.innerHTML = conversationsCache.length ? conversationsCache.map((conv) => {
    const unread = unreadCounts[conv.id] || 0;
    return `
      <button class="conversation-row" data-conversation-id="${conv.id}" type="button">
        <span class="conversation-name">${escapeHtml(conv.partnerNickname)}</span>
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
    resultsBox.hidden = false;
    resultsBox.innerHTML = searchResultsCache.length ? searchResultsCache.map((profile) => `
      <button class="dm-search-result-row" data-user-id="${profile.id}" type="button">
        <span>${escapeHtml(profile.nickname)}</span>
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
  $("#chat-partner-name").textContent = activeChatPartner.nickname;

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

  if (error) toast(`메시지 전송 실패: ${error.message}`);
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
  const { error } = await supabase.from("school_community_posts").insert({
    board_type: $("#post-board").value,
    title: $("#post-title").value.trim(),
    content: $("#post-content").value.trim(),
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
  const { error } = await supabase.from("school_community_comments").insert({
    post_id: selectedPostId,
    author_id: currentUser.id,
    author_nickname: currentProfile.nickname,
    content: $("#comment-content").value.trim()
  });
  if (error) return toast(`댓글 등록 실패: ${error.message}`);
  $("#comment-form").reset();
  toast("댓글이 등록되었습니다.");
  loadDetail();
});

document.addEventListener("click", (event) => {
  const page = event.target.dataset.page;
  if (page) { showPage(page); return; }

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
// (이전 버전은 이 가드가 없어, 글쓰기/댓글/쪽지 등에서 대문자 T를 입력할 때마다
//  관리자(신고 관리) 패널이 열렸다 닫혔다 하며 "꺼지지 않는" 것처럼 보이는 버그가 있었습니다.)
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
// 관리자: 계정 관리 (학번/실명 검색 → 정지·권한·삭제·배추 초기화)
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
      </div>

      <h4>작성 게시글 (${(posts || []).length})</h4>
      <div class="admin-account-list">
        ${(posts || []).map((p) => `
          <div class="admin-account-row">
            <span>${escapeHtml(p.title)} (🥬 ${p.cabbage_count})</span>
            <span class="admin-account-row-btns">
              <button class="admin-reset-cabbage" data-post-id="${p.id}" type="button">배추 초기화</button>
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

  document.querySelectorAll(".admin-reset-cabbage").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const postId = btn.dataset.postId;
      const { error: delError } = await supabase.from("school_community_cabbage_recommends").delete().eq("post_id", postId);
      if (delError) return toast(`배추 초기화 실패: ${delError.message}`);
      const { error: updateError } = await supabase.from("school_community_posts").update({ cabbage_count: 0 }).eq("id", postId);
      if (updateError) return toast(`배추 초기화 실패: ${updateError.message}`);
      toast("배추 추천이 초기화되었습니다.");
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
  } else {
    currentProfile = null;
    isAdmin = false;
    myConversationIds = new Set();
    unsubscribeGlobalDmBadge();
    setDmBadge(false);
  }
  updateHeader();
  showPage(currentUser ? "boards" : "home");
}

const { data: { session } } = await supabase.auth.getSession();
await setSession(session);
supabase.auth.onAuthStateChange((_event, newSession) => { setSession(newSession); });