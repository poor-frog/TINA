# Kien truc va luong hoat dong he thong giong noi TINA

Tai lieu mo ta chi tiet cach hoat dong cua he thong giong noi trong TINA tu luc thu am thanh cuoc hop (Google Meet), loc tap am, xu ly VAD (Voice Activity Detection), nhan dang tieng noi (ASR), nhan dien tu khoa goi (LiveKit WakeWord), truy van cau tra loi (Agent/RAG), cho den tong hop giong noi (TTS) va phat lai vao micro ao.

Với `TINA_LIVEKIT_AUDIO=1`, NS Low chạy trong dịch vụ LiveKit qua WebSocket riêng, rồi PCM được
chia cho transcript, Silero và KWS. Cả cửa sổ ASR transcript lẫn câu hỏi voice đi qua adapter
`livekit.agents.stt.STT` đến đúng ASR đã chọn cho bot. LocalAgreement và nơi lưu
transcript không đổi; transcript liên tục không tự kích hoạt LLM. Smart Turn/Namo vẫn chỉ quan sát.
Xem [cấu hình và giới hạn audio bridge](../deploy/livekit/README.md#local-audio-bridge).

Nhánh hỏi đáp dùng LangGraph trong adapter LLM của LiveKit Agents: lập kế hoạch → gọi tool TINA
→ tìm bổ sung phần còn thiếu → trả lời đã kiểm chứng. Tối đa hai vòng, hai tool mỗi vòng; không
checkpoint hoặc stream bản nháp vào TTS. Task/decision vẫn dùng Pipecat, và API TINA giữ quyền
nguồn, lịch sử đã phát và kiểm chứng. Xem [LangGraph RAG](../deploy/livekit/README.md#langgraph-rag).

---

## 1. So do luong tong quan (Pipeline Architecture)

```mermaid
flowchart TD
    subgraph S1["1. Audio Input va Capture (Google Meet Bot)"]
        User["Người nói trong cuộc họp"] -->|"WebRTC Audio"| GMeet["Google Meet AudioWorklet<br/>(16 kHz Mono Float32, 64 ms/1024 samples)"]
        GMeet -->|"Per-channel routing"| NS["WebRTC NS Low<br/>(Noise Suppression tren CPU)"]
        NS -->|"Clean PCM Frame"| PCMBridge["Capture Bridge<br/>(Tach luong xu ly doc lap)"]
    end

    subgraph S2["2. VAD va ASR (Xu ly song song)"]
        PCMBridge -->|"Tee PCM"| SileroVAD["Native Silero VAD (Sidecar)<br/>(Bat diem dung noi speech_end)"]
        PCMBridge -->|"Buffered Window"| ASR["ASR Backend (Local HTTP)<br/>(VieGem + KenLM + FSMN-VAD)"]
        ASR -->|"ASR Hypotheses (Text + Timestamps)"| GMeetPipe["Gmeet Pipeline<br/>(Timeline va LocalAgreement)"]
    end

    subgraph S3["3. Voice Trigger va LiveKit WakeWord"]
        PCMBridge -->|"PCM theo kenh"| KWS["LiveKit WakeWord · ONNX CPU<br/>TINA ơi / hey TINA"]
        KWS -->|"Xac nhan nguoi goi"| VoiceTrigger["Voice Trigger Engine<br/>(Mot luot hoi, dung kenh va source clock)"]
        GMeetPipe -->|"Cau hoi, khong sua transcript"| VoiceTrigger
        SileroVAD -.->|"speech_end sample clock"| VoiceTrigger
        VoiceTrigger -->|"Wake Confirmed va Question Ready"| FastAck["Phat ACK tuc thi (Prewarmed TTS):<br/>'Da, em nghe.'"]
    end

    subgraph S4["4. Agent Reasoning va Fact Verification"]
        VoiceTrigger -->|"POST /answer (Cau hoi + Speaker Key)"| MeetingAPI["Meeting API (Voice Lifecycle)"]
        MeetingAPI -->|"RAG Query"| AgentEngine["Agent Control Plane<br/>(BM25 + 120s Transcript gan nhat + Docs)"]
        AgentEngine -->|"Draft Answer (2-3 cau ngan)"| Grounding["Fact va Grounding Verification<br/>(Kiem tra so lieu, ngay thang, thuc the)"]
    end

    subgraph S5["5. TTS va Playback (Phat vao phong hop)"]
        Grounding -->|"Validated Vietnamese Text"| Segmenter["Vietnamese Sentence Segmenter<br/>(Chia cau qua Intl.Segmenter)"]
        Segmenter -->|"POST /v1/audio/speech"| TTSEngine["VieNeu-TTS Server (Truc Ly)<br/>(24 kHz mono PCM16 + Pronunciation Dict)"]
        TTSEngine -->|"Streaming PCM Chunks"| Paplay["PulseAudio paplay -> tts_sink"]
        Paplay -->|"Virtual Mic"| MicInject["Bat Mic Google Meet va Phat am thanh<br/>(Mute mic khi ket thuc)"]
    end

    FastAck -.->|"Phat song song khi Agent suy nghi"| TTSEngine
```

---

## 2. So do trinh tu mot luot thoai (Turn Sequence Diagram)

```mermaid
sequenceDiagram
    autonumber
    actor Speaker as Nguoi tham gia (Speaker)
    participant Bot as GMeet Bot (Browser/Worklet)
    participant KWS as LiveKit WakeWord
    participant VAD as Native Silero VAD
    participant ASR as ASR Engine
    participant Trigger as VoiceTrigger (MeetingVoice)
    participant API as Meeting API va Agent (RAG)
    participant TTS as VieNeu-TTS (Truc Ly)
    participant Mic as Virtual Mic (PulseAudio)

    Speaker->>Bot: "TINA oi, ai phu trach phan demo chieu nay?"
    Bot->>VAD: Gui 64ms frame (1024 samples Float32)
    Bot->>KWS: PCM theo kenh (64 ms -> 80 ms)
    KWS-->>Trigger: Wake + kenh + source clock -> CAPTURING
    Bot->>ASR: Gui buffer cua so am thanh
    VAD-->>Trigger: Bao tin hieu speech_end (thoi diem ngung noi)
    ASR-->>Trigger: Gia thuyet ASR: "TINA oi, ai phu trach phan demo chieu nay?"

    Trigger->>Trigger: Dung xac nhan KWS, lay cau hoi tu ASR cung kenh
    Trigger->>Trigger: Cho ASR bao phu diem speech_end -> Trang thai THINKING

    par Phat phan hoi nhanh (Prewarmed ACK)
        Trigger->>TTS: Yeu cau phat: "Da, em nghe."
        TTS->>Mic: Stream PCM -> Bat mic Google Meet
        Mic-->>Speaker: "Da, em nghe." (Phan xa tuc thi)
    and Truy van cau tra loi (Agent / RAG)
        Trigger->>API: POST /answer (kem cau hoi va ngu canh)
        API->>API: RAG tim kiem tren transcript 120s + tai lieu cuoc hop
        API->>API: Agent LLM sinh cau tra loi ngan (2-3 cau)
        API->>API: Grounding review (kiem chung ngay/so lieu tu nguon)
        API-->>Trigger: Tra ve cau tra loi da kiem chung
    end

    Trigger->>Trigger: Chuyen sang trang thai SPEAKING
    loop Tung cau trong cau tra loi
        Trigger->>TTS: POST /v1/audio/speech (cau tieng Viet)
        TTS-->>Mic: Stream PCM -> paplay (tts_sink)
        Mic-->>Speaker: Phat am thanh cau tra loi vao cuoc hop
    end

    Trigger->>Mic: Tat/Mute mic (pactl set-mute)
    Trigger->>Trigger: Doi khoang 800ms yen lang (QUIET) -> San sang LISTENING
```

---

## 3. Bo may trang thai luot thoai (Turn State Machine)

```mermaid
stateDiagram-v2
    [*] --> LISTENING
    LISTENING --> CAPTURING: Nhan ASR chua ten goi hop le (wake)
    CAPTURING --> THINKING: Silero bao speech_end va ASR hoan tat nhan dang
    CAPTURING --> LISTENING: Het thoi gian cho (timeout) hoac audio mo ho
    THINKING --> SPEAKING: Agent tra loi va xac thuc nguon thanh cong
    THINKING --> ERROR: Loi xu ly hoac khong du bang chung
    SPEAKING --> QUIET: Doc xong tat ca cac cau qua TTS
    QUIET --> LISTENING: Nhan du 800ms yen lang trong phong hop
```

---

## 4. Chi tiet cac thanh phan ky thuat

### 4.1. Thu nhan va Tien xu ly am thanh (Audio Input & Noise Suppression)
- **Co che thu am**: [pcm-capture.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/modules/gmeet-capture/src/pcm-capture.ts) chay trong trang Google Meet thong qua AudioWorklet, trich xuat am thanh do tre thap o dinh dang **16 kHz Mono Float32** voi kich thuoc khung **64 ms (1024 samples)**.
- **Dinh tuyen theo kenh (Channel-routed)**: Moi nguoi noi trong Google Meet duoc tach biet tren tung kenh doc lap (`ch-<n>`), gan nhan danh tinh bang vien sang avatar (glow name) tai thoi diem bat dau noi theo [gmeet-pipeline.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/modules/gmeet-pipeline/src/gmeet-pipeline.ts).
- **Khu on WebRTC NS Low**: Duoc cai dat tai [noise-suppression.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/services/bot/src/noise-suppression.ts), chay tren CPU qua thu vien native `webrtc-audio-processing` 0.3.1. Su dung hang doi FIFO 160 mau, bu tre thuat toan 96 mau (6 ms) de lam sach am thanh truoc khi dua vao VAD va ASR.

### 4.2. VAD va Nhan dang giong noi (Silero VAD & Local ASR)
- **Silero VAD cuc bo**: [meeting-voice.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/services/bot/src/meeting-voice.ts) khoi tao process con Python chay Silero VAD (~644 KB) o che do `--vad-only` tren CPU. Silero theo doi tung kenh de bat chinh xac mau am thanh ket thuc tieng noi (`speech_end`), loai bo khoang lang thua o cuoi cau.
- **ASR Engine tu host**:
  - Mo hinh: **VieGem CTC + KenLM + FSMN-VAD** ([engine.py (VieGem)](file:///Users/jky/orca/pre-TINA/TINA/deploy/transcription/viegem/engine.py)).
  - Toi uu tu khoa: KenLM duoc cau hinh name bias uu tien nhan dien tu `"tina"`.
  - [transcription-client.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/modules/whisper/src/transcription-client.ts) gui cac cua so am thanh dinh ky (chu ky 2 giay hoac khi co su kien ngat cau tu VAD) qua HTTP cuc bo.

### 4.3. Co che Wakeword: ASR-Addressed Voice Assistant
Trong bot Google Meet cua TINA, khong can chay them mo hinh KWS (Keyword Spotting) rieng biet, giup toi uu CPU. Thay vao do, he thong su dung co che **ASR-Addressed** tai [voice-trigger.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/services/bot/src/voice-trigger.ts):
- **Cac bien the ten duoc nhan dien o dau cau** (khong phan biet hoa thuong, chuan hoa Unicode NFKC):
  - `TINA`, `Tina`, `TINA oi`, `tin oi`, `ti na oi`, `tien na oi`, `tinh anh oi`, `tin anh oi`.
  - Luu y: Tu choi cac tien to chao tieng Anh (`Hey TINA`, `Hi TINA`) hoac goi giua cau de tranh kich hoat ngoai y muon.
- **Hai kich ban goi**:
  1. *Goi kem cau hoi ngay*: "TINA oi, ai phu trach demo?" -> Trich xuat cau hoi ngay sau ten goi.
  2. *Goi dung mot minh*: "TINA oi" -> Mo khoang cho ngan (toi da 5 giay) de nguoi noi tren chinh kenh do tiep tuc cau hoi.

### 4.4. Xu ly cau tra loi va Kiem chung nguon (Agent & Verification)
- **Phan hoi tuc thi (Fast ACK)**: Ngay khi cau hoi da san sang (`question_ready`), bot lap tuc phat audio prewarm "Da, em nghe." ([meeting-voice.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/services/bot/src/meeting-voice.ts#L367)) de nguoi dung biet he thong da tiep nhan, giam cam giac cho doi.
- **Truy xuat thong tin (RAG)**: [voice.py](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/services/meeting-api/src/meeting_api/lifecycle/voice.py) goi Agent Service de tim kiem du lieu bang BM25, ket hop toi da 12 phan doan transcript trong 120 giay gan nhat va tai lieu Markdown lien ket.
- **Kiem chung tinh xac thuc (Source Grounding Review)**: Truoc khi xuat cau tra loi, he thong kiem tra doi chieu cac con so, ngay thang, thuc the voi bang chung nguon goc nham ngan chan hallucination.

### 4.5. Tong hop giong noi va Phat vao Micro ao (TTS & Virtual Mic)
- **Chuan hoa phat am**: [speech_text.py](file:///Users/jky/orca/pre-TINA/TINA/deploy/tts/speech_text.py) va [pronunciations.json](file:///Users/jky/orca/pre-TINA/TINA/deploy/tts/pronunciations.json) chuyen doi cac ky tu so, ngay thang, tu viet tat cong nghe sang dang doc phien am chuan tieng Viet.
- **Mo hinh TTS**: Su dung **VieNeu-TTS** (giong nu mien Nam Truc Ly) tai [server.py](file:///Users/jky/orca/pre-TINA/TINA/deploy/tts/server.py), xuat am thanh **24 kHz Mono PCM16**. Server co hang doi FIFO bounded toi da 1 tac vu chay va 3 tac vu cho.
- **Phat tung cau (Sentence Chunking)**: [tts-playback.ts](file:///Users/jky/orca/pre-TINA/TINA/core/meetings/services/bot/src/tts-playback.ts) chia nho cau tra loi bang `Intl.Segmenter('vi')`. Tung cau duoc tong hop va truyen (stream) qua lenh `paplay` vao thiet bi `tts_sink` cua PulseAudio.
- **Dieu khien Micro**: Bot tu dong kich hoat `pactl set-source-mute virtual_mic 0` va nhan nut bat mic tren giao dien Google Meet. Sau khi phat xong cau cuoi cung, mic se duoc mute lai de chong tieng vang (echo loop).

---

## 5. Che do Host Speech Client doc lap (clients/speech)

Ngoai luong voice bot trong Google Meet o tren, TINA con cung cap mot cong cu chay tren may tinh ca nhan nguoi dung tai [clients/speech](file:///Users/jky/orca/pre-TINA/TINA/clients/speech/README.md). Che do nay su dung thu vien **Sherpa-ONNX** tren CPU cung mo hinh GigaSpeech INT8 (3.3M tham so) de lang nghe truc tiep tu microphone may tinh va phat hien tu khoa "Hey TINA".




&nbsp;

```
┌────────────────────┐         WebRTC / SIP          ┌──────────────────────┐
│   USER / CLIENT    │ ◄═══════════════════════════► │    LIVEKIT SERVER    │
│ (Web, App, Phone)  │   Audio, Video, Data Track    │   (SFU Media Room)   │
└────────────────────┘                               └──────────┬───────────┘
                                                                ║
                                                   Job Dispatch ║ WebRTC
                                                   & Media      ║ Participant
                                                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         LIVEKIT AGENT SERVER (Worker)                     │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                           AgentSession                              │  │
│  │                                                                     │  │
│  │  [Audio In] ──► [Noise Cancel] ──► [VAD + Turn Detector]            │  │
│  │                                             │                       │  │
│  │         ┌───────────────────────────────────┴───────────────┐       │  │
│  │         ▼ (Nhánh 1: Cascaded Pipeline)  (Nhánh 2: Realtime) ▼       │  │
│  │   ┌───────────┐                                     ┌─────────────┐ │  │
│  │   │    STT    │                                     │  Realtime   │ │  │
│  │   └─────┬─────┘                                     │ Multimodal  │ │  │
│  │         ▼                                           │    Model    │ │  │
│  │   ┌───────────┐       ┌─────────────────────┐       │  (OpenAI /  │ │  │
│  │   │    LLM    │ ◄───► │ Function Tools / MCP│ ◄───► │ Gemini Live)│ │  │
│  │   └─────┬─────┘       └─────────────────────┘       └──────┬──────┘ │  │
│  │         ▼                                                  │        │  │
│  │   ┌───────────┐                                            │        │  │
│  │   │    TTS    │                                            │        │  │
│  │   └─────┬─────┘                                            │        │  │
│  │         └───────────────────────┬──────────────────────────┘        │  │
│  │                                 ▼                                   │  │
│  │                 [Audio Out / Transcription / Avatar]                │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```


```mermaid
flowchart TD
    AUDIO["Người dùng gọi TINA và đặt câu hỏi"]
    AUDIO --> ASR["ASR hiện tại<br/>VieGem hoặc endpoint đã cấu hình"]
    ASR --> LK["LiveKit Agents"]
    LK --> GRAPH["LangGraph<br/>Chọn tool và phạm vi tra cứu"]

    subgraph RETRIEVAL["Retrieval Engine V2"]
        SCOPE["Kiểm tra quyền nguồn<br/>Meeting / tài liệu được chia sẻ"]
        FILTER["Lọc metadata đã xác định<br/>Meeting · Speaker ID · Time"]

        RAW["BM25 Raw<br/>Giữ tên, mã và thuật ngữ"]
        VI["Underthesea + Domain Dictionary<br/>BM25 Vietnamese"]
        DENSE["E5 Semantic Search<br/>Văn bản tự nhiên"]
        FUZZY["Alias Mapping + Character N-gram<br/>Mở rộng ứng viên có giới hạn"]

        FUSION["Weighted RRF<br/>Gộp hạng + loại kết quả trùng"]
        BOOST["Ưu tiên ngữ cảnh phù hợp<br/>Entity · nguồn hội thoại · lời nói gần đây"]
        RERANK["Reranking<br/>Thử BGE-v2-m3 so với LLM hiện tại"]
        WINDOW["Sentence Window Retrieval<br/>Lấy thêm ngữ cảnh quanh đoạn trúng"]
        PACK["Structured Evidence Pack<br/>Quote gốc · ID · revision · fingerprint<br/>speaker/time · vị trí nguồn"]

        SCOPE --> FILTER
        FILTER --> RAW
        FILTER --> VI
        FILTER --> DENSE
        FILTER -.-> FUZZY

        RAW --> FUSION
        VI --> FUSION
        DENSE --> FUSION
        FUZZY -.-> FUSION

        FUSION --> BOOST
        BOOST --> RERANK
        RERANK --> WINDOW
        WINDOW --> PACK
    end

    GRAPH --> SCOPE
    PACK --> ASSESS{"LangGraph đánh giá kết quả"}

    ASSESS -->|"Cần tìm bổ sung, còn ngân sách"| GRAPH
    ASSESS -->|"Đủ hoặc trả lời được một phần"| LLM["LLM soạn câu trả lời"]
    ASSESS -->|"Yêu cầu mơ hồ"| ASK["Hỏi lại ngắn gọn"]
    ASSESS -->|"Không còn nguồn dùng được"| ERROR["Báo lỗi hoặc thiếu bằng chứng<br/>theo đúng nguyên nhân"]

    LLM --> VERIFY["API TINA kiểm chứng câu trả lời<br/>Kiểm tra nguồn và quyền hiện tại"]
    VERIFY --> OUTPUT["Terminal / Extension<br/>VieNeu-TTS → bot phát"]
    ASK --> OUTPUT


```
