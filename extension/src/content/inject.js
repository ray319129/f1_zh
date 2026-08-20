/**
 * MAIN world content script —— Worker 注入
 *
 * 為什麼需要這支：
 * F1TV 的串流網路請求全部發生在一個 blob: Web Worker 內（核心是約 7MB 的 WASM）。
 * Worker 有自己的全域環境，主執行緒 patch fetch/XHR 完全攔不到。
 *
 * 而擴充功能必須拿到 VTT 才有「提前量」——播放器會提前約 50 秒下載字幕分段，
 * 那正是 userscript 跟得上轉播語速、而純 DOM 版跟不上的唯一原因。
 *
 * 為什麼不用 PLAY API：
 * 試過八個版本。header 名稱、權杖值、URL 參數全部解決之後，即使原封不動
 * 重放播放器自己的網址，伺服器仍回 500 "Failed to evaluate stream rule"——
 * 還缺我們無法窮舉的裝置／平台 header。而且 F1TV 掛了 Imperva 機器人防護
 * （reese84 cookie），持續送注定失敗的請求只是在累積風險。
 *
 * Worker 注入反而**不產生任何額外的網路請求**，它只是搭播放器自己的請求便車。
 *
 * ── 安全設計（都是 userscript 實測踩過的坑）──
 *   1. 只處理 `instanceof Blob`。URL.createObjectURL(mediaSource) 傳的是
 *      MediaSource 不是 Blob —— 那是影片本身，絕對不能碰
 *   2. 用 BroadcastChannel 不用 postMessage。postMessage 會把我們的訊息塞進
 *      播放器自己的訊息通道，它的 handler 若對未知格式拋錯，播放會直接壞掉
 *   3. worker 內只 clone 小的文字類回應。持續 clone 影片分段會吃爆記憶體
 */

(function () {
  'use strict';

  const CHANNEL = 'pitlingo-vtt';
  const MARK = '__pitlingo_vtt__';

  // 注入到 worker 內部的程式碼。以字串形式前置到原始腳本前面。
  // 全部打包在擴充功能內，不是遠端程式碼。
  const WORKER_HOOK = `
(function(){
  try{
    var BC=null; try{ BC=new BroadcastChannel(${JSON.stringify(CHANNEL)}); }catch(e){}
    function send(o){ try{ if(BC) BC.postMessage(o); }catch(e){} }
    // 解碼出來的東西到底像不像文字。
    // 影片與音訊分段用 TextDecoder 硬解會得到一堆控制字元，其中偶爾就會
    // 湊出 "-->" 三個位元組（0x2D 0x2D 0x3E）——那時整段二進位垃圾會被
    // 當成 VTT 送進翻譯佇列，最後變成後端的「單句長度不可超過 1000 字元」。
    // 只看前 256 字元，成本可忽略。
    function looksText(t){
      var n=Math.min(256,t.length), ctrl=0;
      for(var i=0;i<n;i++){
        var c=t.charCodeAt(i);
        if(c===0) return false;                                   // NUL＝一定不是文字
        if(c<32 && c!==9 && c!==10 && c!==13) ctrl++;
        if(c===0xFFFD) ctrl++;                                    // 解碼失敗的替代字元
      }
      return ctrl <= n*0.05;
    }
    function emit(t,u){
      try{
        if(!t || typeof t!=='string') return;
        if(!looksText(t)) return;
        // ⚠️ 網址絕不截斷。F1TV 的 master m3u8 路徑帶著很長的 base64 授權
        //    token，切掉之後相對路徑解析會把整段 token 吃掉，抓分段一律 400。
        //    （userscript 坑 #3，這裡曾經寫成 slice(0,300)）
        var url=String(u||'');
        if(t.indexOf('-->')!==-1){ send({vtt:t, url:url}); return; }
        // m3u8／MPD：整軌預抓的來源。master 裡的 #EXT-X-MEDIA:TYPE=SUBTITLES
        // 指向字幕清單，那份清單列出整支影片每一個 VTT 分段。
        // 600000 是踩過坑 #7 之後的值——兩小時正賽的字幕清單有上千段。
        if(/#EXTM3U|<MPD/i.test(t.slice(0,400))) send({manifest:t.slice(0,600000), url:url});
      }catch(e){}
    }
    // 只碰小的、文字類的回應。**絕不 clone 影片與音訊分段。**
    //
    // ⚠️ 這個函式修過一次，原因是使用者實際回報「影片時不時轉圈圈」。
    //    舊版最後一行是 \`return n>0 && n<300000\`——**只看大小不看型別**，
    //    而 HLS 的音訊分段與低位元率的影片分段幾乎都落在 300KB 以內。
    //    於是每一個媒體分段都被 clone 一份、用 TextDecoder 整個解成字串、
    //    再對那串二進位垃圾做 indexOf 掃描，最後才丟掉。
    //    後果有三個，全部不會報錯：
    //      1. 每個分段的記憶體加倍，長時間觀看累積成 GC 壓力 → **播放卡頓**
    //      2. clone 出來的分支要被讀完，對播放器的下載造成背壓
    //      3. 二進位垃圾偶爾湊出 "-->" → 被當成字幕送去翻譯（見 looksText）
    //    註解一直寫著「只 clone 小的文字類回應」，但程式碼的第三條規則
    //    根本沒有檢查型別——這正是坑 #7 說的那件事。
    //
    // 順序有意義：**先排除，再納入**，最後才是那條保守的大小規則。
    function interesting(url,ct,len){
      var u=String(url||''), c=String(ct||'');
      // 1. 確定是媒體的一律不碰
      if(/^(video|audio|image)\\//i.test(c)) return false;
      if(/octet-stream|mp4|iso\\.segment/i.test(c) && !/vtt|text/i.test(c)) return false;
      if(/\\.(m4s|mp4|m4v|m4a|ts|aac|mp3|cmf[av]|init|jpe?g|png|webp)(\\?|$)/i.test(u)) return false;
      // 2. 確定是文字／字幕／清單的才要
      if(/text\\/|vtt|dash\\+xml|mpegurl/i.test(c)) return true;
      if(/\\.(vtt|webvtt|m3u8|mpd)(\\?|$)|subtitle|caption|\\bsub\\b/i.test(u)) return true;
      // 3. 兩邊都判斷不出來時只接受**很小**的回應。
      //    一段 6 秒的字幕 VTT 只有幾百到幾 KB，64KB 已經非常寬鬆；
      //    而 300KB 會把整批音訊分段掃進來，那就是上面說的那個 bug。
      var n=parseInt(len||'0',10);
      return n>0 && n<65536;
    }
    var of=self.fetch;
    if(typeof of==='function'){
      self.fetch=function(){
        var args=arguments, p=of.apply(this,args);
        try{
          var a0=args[0], u=(typeof a0==='string')?a0:((a0&&a0.url)||'');
          p.then(function(r){
            try{
              var h=r.headers, ct=(h&&h.get)?h.get('content-type'):'', cl=(h&&h.get)?h.get('content-length'):'';
              if(!interesting(u,ct,cl)) return;
              r.clone().text().then(function(t){emit(t,u);}).catch(function(){});
            }catch(e){}
          }).catch(function(){});
        }catch(e){}
        return p;
      };
    }
    var XP=self.XMLHttpRequest && self.XMLHttpRequest.prototype;
    if(XP && !XP.__pl){
      XP.__pl=true;
      var oo=XP.open, os=XP.send;
      XP.open=function(m,u){ try{this.__u=u;}catch(e){} return oo.apply(this,arguments); };
      XP.send=function(){
        try{
          this.addEventListener('load',function(){
            try{
              var ct=this.getResponseHeader?this.getResponseHeader('content-type'):'';
              var cl=this.getResponseHeader?this.getResponseHeader('content-length'):'';
              if(!interesting(this.__u,ct,cl)) return;
              var t=null, rt=this.responseType;
              if(rt===''||rt==='text') t=this.responseText;
              else if(rt==='arraybuffer'&&this.response) t=new TextDecoder('utf-8',{fatal:false}).decode(new Uint8Array(this.response));
              emit(t,this.__u);
            }catch(e){}
          });
        }catch(e){}
        return os.apply(this,arguments);
      };
    }
  }catch(e){}
})();
`;

  let patched = 0;

  function installBlobWorkerInjection() {
    try {
      const U = self.URL || self.webkitURL;
      if (!U || U.__pitlingoPatched) return;
      const orig = U.createObjectURL.bind(U);
      U.__pitlingoPatched = true;

      U.createObjectURL = function (obj) {
        const url = orig(obj);
        try {
          // MediaSource 走的也是這條 —— 那是影片本身，絕對不能動。
          // MediaSource 不是 Blob，這個檢查就足以放行。
          if (typeof Blob === 'undefined' || !(obj instanceof Blob)) return url;
          if (obj.size > 8e6) return url;
          const ty = (obj.type || '').toLowerCase();
          if (ty && !/javascript|ecmascript|text\/plain/.test(ty)) return url;

          // blob: 的同步讀取沒有網路成本，瞬間完成
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, false);
          xhr.send();
          const src = xhr.responseText || '';
          if (!src || !/self\.|onmessage|postMessage|importScripts|addEventListener/.test(src)) return url;

          const blob = new Blob([WORKER_HOOK, '\n', src], { type: obj.type || 'text/javascript' });
          patched++;
          // targetOrigin 用實際來源，不要用 '*'——'*' 會讓頁面上任何 iframe 都收得到
          window.postMessage({ [MARK]: true, kind: 'injected', bytes: src.length }, location.origin);
          return orig(blob);
        } catch (e) {
          return url;   // 任何差錯都回傳原始網址，絕不影響播放
        }
      };
    } catch (e) { /* noop */ }
  }

  /**
   * worker 用 BroadcastChannel 把攔到的東西送回來。
   * 這裡（MAIN world）再用 window.postMessage 轉給 ISOLATED world 的主程式——
   * 那邊才有 chrome.* API 可以呼叫 service worker。
   *
   * 兩種內容：
   *   vtt      —— 播放器提前約 50 秒下載的字幕分段，提前量的來源
   *   manifest —— m3u8／MPD，整軌預抓的來源（見 main.js 的 findSubtitlePlaylist）
   */
  function installRelay() {
    try {
      const bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (ev) => {
        const d = ev && ev.data;
        if (!d) return;
        if (typeof d.vtt === 'string') {
          window.postMessage({ [MARK]: true, kind: 'vtt', vtt: d.vtt, url: d.url || '' }, location.origin);
        } else if (typeof d.manifest === 'string') {
          window.postMessage({ [MARK]: true, kind: 'manifest', manifest: d.manifest, url: d.url || '' }, location.origin);
        }
      };
    } catch (e) { /* noop */ }
  }

  installBlobWorkerInjection();
  installRelay();
})();
