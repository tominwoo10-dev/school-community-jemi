const SUPABASE_URL = "https://nsnpmnjmbzecpvswcnlc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_XVPVmjOt_6mgbTTS-8m4SA_h9YEg4d0";

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (selector) => document.querySelector(selector);

let currentUser = null, currentProfile = null, currentBoard = "고민", selectedPostId = null, isAdmin = false;
let activeConversationId = null, activeChatPartner = null, chatRealtimeChannel = null, dmSearchDebounce = null;

const studentEmail = (studentId) => `student-${studentId.trim()}@school-community.invalid`;
const escapeHtml = (text) => { const div = document.createElement("div"); div.textContent = text || ""; return div.innerHTML; };
const time = (value) => value ? new Date(value).toLocaleString("ko-KR") : "방금 전";

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

function showPage(name) { 
  if (["boards", "write", "detail", "dms", "chat"].includes(name) && !currentUser) { 
    toast("로그인이 필요한 페이지입니다."); 
    name = "login"; 
  } 

  if (name !== "chat") unsubscribeFromChat();
  document.body.style.overflow = "";

  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active")); 
  const targetPage = $(`#page-${name}`);
  if (targetPage) targetPage.classList.add("active"); 
  
  if (name === "boards") loadPosts(); 
  if (name === "detail") loadDetail(); 
  if (name === "dms") loadConversations();
  if (name === "chat") loadChatMessages();
  window.scrollTo(0, 0); 
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

  postList.innerHTML = posts.length ? posts.map((post) => `
    <button class="post-row" data-post-id="${post.id}" type="button">
      <span class="badge">${post.board_type}</span>
      <h2>${escapeHtml(post.title)}</h2>
      <p class="excerpt">${escapeHtml(post.content)}</p>
      <div class="bottom">
        <span>${escapeHtml(post.author_nickname)} · ${time(post.created_at)}</span>
        <span>🥬 ${post.cabbage_count} · 👀 조회 ${post.view_count || 0} · 💬 댓글 ${post.comment_count}</span>
      </div>
    </button>
  `).join("") : `<div class="post-row" style="text-align:center; color:var(--muted);">등록된 글이 존재하지 않습니다.</div>`;
}

async function loadDetail() {
  if (!selectedPostId) return;

  // 증가 차단 레이스방지 RPC 호출
  await supabase.rpc("increment_view_count", { post_id: selectedPostId });

  const { data: post, error } = await supabase.from("school_community_posts").select("*").eq("id", selectedPostId).single();
  if (error) { toast("게시글을 찾을 수 없거나 이미 삭제 처리되었습니다."); return showPage("boards"); }
  
  const { data: myCabbage } = await supabase.from("school_community_cabbage_recommends").select("post_id").eq("post_id", post.id).maybeSingle();
  const ownPost = currentUser && post.author_id === currentUser.id;
  const dmBtnHtml = (!ownPost && currentUser) ? `<button class="text-button" id="btn-open-dm" type="button" style="font-size:12px; margin-left:8px; background:#eef2ff; color:var(--blue); padding:4px 10px; border-radius:6px; border:1px solid #dce2ed;">✉ 쪽지 보내기</button>` : "";

  const postDetail = $("#post-detail");
  if (!postDetail) return;

  postDetail.innerHTML = `
    <span class="badge">${post.board_type}</span>
    <h1>${escapeHtml(post.title)}</h1>
    <div class="meta">${escapeHtml(post.author_nickname)}${dmBtnHtml} · 👀 조회 ${post.view_count || 0} · ${time(post.created_at)}</div>
    <div class="detail-content">${escapeHtml(post.content)}</div>
    <div class="actions">
      <button class="cabbage" id="cabbage-button" type="button">${myCabbage ? "🥬 배추 추천 취소" : "🥬 배추 추천"} ${post.cabbage_count}</button>
      ${ownPost ? `<button class="danger" id="own-delete" type="button">글 삭제</button>` : ""}
    </div>
  `;

  if (!ownPost && $("#btn-open-dm")) {
    $("#btn-open-dm").addEventListener("click", () => {
      startConversationAndOpen(post.author_id, post.author_nickname);
    });
  }

  $("#cabbage-button").addEventListener("click", () => toggleCabbage(post.id, Boolean(myCabbage)));
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

  list.innerHTML = convs.length ? convs.map((conv) => {
    const isUser1 = conv.user1 === currentUser.id;
    const partnerId = isUser1 ? conv.user2 : conv.user1;
    const partnerNickname = isUser1 ? conv.user2_nickname : conv.user1_nickname;
    const unread = unreadCounts[conv.id] || 0;
    return `
      <button class="conversation-row" data-conversation-id="${conv.id}" data-partner-id="${partnerId}" data-partner-nickname="${escapeHtml(partnerNickname)}" type="button">
        <span class="conversation-name">${escapeHtml(partnerNickname)}</span>
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
    // 익명성 보호: 닉네임으로만 검색하며, 실명/학번/학년/반은 절대 조회하지 않습니다.
    const { data, error } = await supabase
      .from("school_community_searchable_profiles")
      .select("id,nickname")
      .ilike("nickname", `%${query}%`)
      .neq("id", currentUser?.id || "")
      .limit(10);

    if (error) return toast(`검색 실패: ${error.message}`);

    resultsBox.hidden = false;
    resultsBox.innerHTML = data.length ? data.map((profile) => `
      <button class="dm-search-result-row" data-user-id="${profile.id}" data-nickname="${escapeHtml(profile.nickname)}" type="button">
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
    return `
      ${dateDivider}
      <div class="chat-bubble-row ${isMine ? "mine" : "theirs"}">
        <div class="chat-bubble">${escapeHtml(msg.content)}</div>
        <span class="chat-bubble-time">${timeLabel}</span>
      </div>
    `;
  }).join("") : `<div class="chat-empty">첫 메시지를 보내보세요.</div>`;

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
      event: "INSERT",
      schema: "public",
      table: "school_community_messages",
      filter: `conversation_id=eq.${activeConversationId}`
    }, async (payload) => {
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
      if (payload.new.sender_id !== currentUser.id) {
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
        grade: parseInt(grade, 10),
        class: parseInt(klass, 10),
        number: parseInt(numRaw, 10)
      }
    }
  });

  if (error) return toast(`회원가입 실패: ${error.message}`);
  
  // 레이스 컨디션 방지 완충재 주입
  if (data?.user) {
    currentUser = data.user;
    currentProfile = { id: data.user.id, nickname: nickname, role: "student" };
    updateHeader();
  }
  toast("회원가입이 완료되었습니다!");
  $("#signup-form").reset();
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

$("#login-form").addEventListener("submit", async (event) => { 
  event.preventDefault(); 
  const { error } = await supabase.auth.signInWithPassword({ 
    email: studentEmail($("#login-student-id").value), 
    password: $("#login-password").value 
  }); 
  if (error) toast("학번 정보 또는 비밀번호를 다시 확인하세요."); 
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
  
  const board = event.target.dataset.board; 
  if (board) { 
    currentBoard = board; 
    document.querySelectorAll("#board-tabs button").forEach((button) => button.classList.toggle("active", button === event.target)); 
    loadPosts(); 
    return;
  } 
  
  const postRow = event.target.closest(".post-row");
  if (postRow) { 
    selectedPostId = postRow.dataset.postId; 
    showPage("detail"); 
    return;
  } 

  const conversationRow = event.target.closest(".conversation-row");
  if (conversationRow) {
    activeConversationId = conversationRow.dataset.conversationId;
    activeChatPartner = {
      id: conversationRow.dataset.partnerId,
      nickname: conversationRow.dataset.partnerNickname
    };
    showPage("chat");
    return;
  }

  const searchResultRow = event.target.closest(".dm-search-result-row");
  if (searchResultRow) {
    startConversationAndOpen(searchResultRow.dataset.userId, searchResultRow.dataset.nickname);
  }
});

document.addEventListener("keydown", (event) => { 
  if (event.shiftKey && event.key.toLowerCase() === "t") { 
    if (!isAdmin) return; 
    const panel = $("#admin-panel");
    if (panel) panel.hidden = !panel.hidden; 
  } 
});

$("#admin-close").addEventListener("click", () => { $("#admin-panel").hidden = true; });

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

async function setSession(session) {
  currentUser = session?.user || null; 
  
  if (currentUser) {
    const { data, error } = await supabase.from("school_community_profiles").select("id,nickname,role").eq("id", currentUser.id).maybeSingle();
    if (error) { 
      toast("인증 동기화 실패"); 
      await supabase.auth.signOut(); 
      return; 
    }
    if (data) {
      currentProfile = data; 
      isAdmin = data.role === "admin";
    }
  } else {
    currentProfile = null;
    isAdmin = false;
  }
  updateHeader(); 
  showPage(currentUser ? "boards" : "home");
}

const { data: { session } } = await supabase.auth.getSession();
await setSession(session);
supabase.auth.onAuthStateChange((_event, newSession) => { setSession(newSession); });