import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
  TFile,
} from 'obsidian';

// ==================== Interfaces ====================
interface StudentActivityPluginSettings {
  apiProvider: 'openai' | 'claude' | 'gemini' | 'grok';
  apiKey: string;
  targetCharCount: number;
  outputFolder: string;
  modelId: string;
}

// ==================== Model Lists (Updated: 2025-12-14) ====================
const MODEL_OPTIONS: Record<string, { id: string; name: string }[]> = {
  openai: [
    // GPT-5 Series (Reasoning Models)
    { id: 'gpt-5', name: 'GPT-5 (Reasoning)' },
    { id: 'gpt-5-mini', name: 'GPT-5 Mini (Reasoning)' },
    { id: 'gpt-5-nano', name: 'GPT-5 Nano (Reasoning)' },
    // GPT-4o Series
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    // GPT-4 Series
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-4', name: 'GPT-4' },
    // Legacy
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
  ],
  claude: [
    // Claude 4.x Series (Latest)
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5 (Recommended)' },
    { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    // Claude 3.7 Series
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
    // Claude 3.5 Series
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Fastest)' },
    // Claude 3 Series (Legacy)
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
  ],
  gemini: [
    // Gemini 2.5 Series (Latest)
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Stable)' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
    // Gemini 2.0 Series
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.0-flash-preview-image-generation', name: 'Gemini 2.0 Flash (Image Gen)' },
    // Gemini 1.5 Series
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B' },
  ],
  grok: [
    // Grok 4.x Series (Latest)
    { id: 'grok-4-0709', name: 'Grok 4' },
    { id: 'grok-4-1-fast', name: 'Grok 4.1 Fast (Recommended)' },
    { id: 'grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Fast (Non-Reasoning)' },
    // Grok 3 Series
    { id: 'grok-3', name: 'Grok 3' },
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
    // Grok Code
    { id: 'grok-code-fast-1', name: 'Grok Code Fast' },
    // Grok 2 Series (Legacy)
    { id: 'grok-2-vision-1212', name: 'Grok 2 Vision' },
    { id: 'grok-2-image-1212', name: 'Grok 2 Image' },
  ],
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  claude: 'claude-sonnet-4-5-20250929',
  gemini: 'gemini-2.5-flash',
  grok: 'grok-4-1-fast',
};

interface StudentActivity {
  studentId: string;
  studentName: string;
  activityContent: string;
}

interface ObservationRecord {
  studentId: string;
  studentName: string;
  activityContent: string;
  observation: string;
  charCount: number;
  byteCount: number;
}

const DEFAULT_SETTINGS: StudentActivityPluginSettings = {
  apiProvider: 'openai',
  apiKey: '',
  targetCharCount: 500,
  outputFolder: '',
  modelId: 'gpt-4o-mini',
};

// ==================== Utility Functions ====================

/**
 * NEIS 기준 글자 수 계산 (모든 문자를 1개로 계산)
 */
function countChars(text: string): number {
  return text.length;
}

/**
 * NEIS 기준 바이트 수 계산 (NEIS_WordCount 로직 사용)
 * - 한글/한자 등: 3바이트 (escape 길이 > 4)
 * - 영문/숫자/특수문자/공백/줄바꿈: 1바이트
 */
function countBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '\n') {
      bytes += 1; // 줄바꿈
    } else if (escape(char).length > 4) {
      bytes += 3; // 한글/한자 등
    } else {
      bytes += 1; // 영문/숫자/특수문자/공백
    }
  }
  return bytes;
}

/**
 * 목표 글자수 → 예상 바이트수 계산 (한글 80% 가정)
 */
function estimateBytes(charCount: number): number {
  return Math.round(charCount * 0.8 * 3 + charCount * 0.2 * 1);
}

/**
 * TSV 데이터 파싱 (탭 구분)
 */
function parseTSV(data: string): StudentActivity[] {
  const lines = data.trim().split('\n');
  const activities: StudentActivity[] = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      activities.push({
        studentId: parts[0].trim(),
        studentName: parts[1].trim(),
        activityContent: parts.slice(2).join(' ').trim(),
      });
    }
  }

  return activities;
}

/**
 * 마크다운 테이블 생성 (학번, 성명, 학생활동기록, 교사관찰기록, 글자 수, 바이트 수)
 */
function generateMarkdownTable(records: ObservationRecord[]): string {
  let table = '| 학번 | 성명 | 학생활동기록 | 교사관찰기록 | 글자 수 | 바이트 수 |\n';
  table += '|------|------|-------------|-------------|---------|----------|\n';

  for (const record of records) {
    const escapedActivity = record.activityContent.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const escapedObservation = record.observation.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    table += `| ${record.studentId} | ${record.studentName} | ${escapedActivity} | ${escapedObservation} | ${record.charCount} | ${record.byteCount} |\n`;
  }

  return table;
}

/**
 * 구글 스프레드시트용 TSV 데이터 생성 (탭 구분)
 */
function generateTSVData(records: ObservationRecord[]): string {
  let tsv = '학번\t성명\t학생활동기록\t교사관찰기록\t글자 수\t바이트 수\n';

  for (const record of records) {
    // 탭과 줄바꿈을 공백으로 대체하여 셀 구분 유지
    const cleanActivity = record.activityContent.replace(/[\t\n\r]/g, ' ');
    const cleanObservation = record.observation.replace(/[\t\n\r]/g, ' ');
    tsv += `${record.studentId}\t${record.studentName}\t${cleanActivity}\t${cleanObservation}\t${record.charCount}\t${record.byteCount}\n`;
  }

  return tsv;
}

// ==================== AI Service ====================

const SYSTEM_PROMPT = `당신은 학생을 깊이 이해하고 애정을 가지고 관찰하는 한국 고등학교 담임교사입니다.
학생의 활동 내용을 바탕으로 교사 관찰 기록을 작성해주세요.

[핵심 원칙]
- 인공지능이 작성한 것이 아닌, 교사가 학생을 직접 관찰하고 애정을 담아 작성한 기록처럼 보여야 합니다
- 학생의 강점, 노력, 성장 과정을 따뜻하게 서술합니다
- 객관적 사실에 기반하되, 교사의 긍정적 관점을 담습니다

[문체 규칙]
- 서술형 종결어미 사용: "~함", "~임", "~남", "~보임", "~드러냄"
- 제목, 머리말, 학생 이름 포함 금지
- 3인칭 관찰자 시점으로 작성
- 한 문단으로 자연스럽게 이어지도록 작성

[내용 구성]
1. 활동의 구체적 맥락과 참여 양상
2. 학생이 보여준 역량이나 태도
3. 활동을 통한 성장이나 발전 가능성

[피해야 할 표현]
- AI, VR, AR 등 영문 약어 → 인공지능, 가상현실, 증강현실 사용
- 과도한 수식어나 빈 칭찬
- 모든 학생에게 적용 가능한 일반적인 표현
- 기계적이거나 정형화된 문장 패턴

[좋은 예시 표현]
- "탐구 과정에서 꼼꼼한 자료 조사와 논리적 분석력을 보여줌"
- "모둠 활동 시 다양한 의견을 존중하며 협력적 태도로 참여함"
- "스스로 문제를 발견하고 해결책을 모색하는 자기주도적 학습 역량을 갖춤"

[출력 형식]
- 추가 설명이나 머리말 없이 교사관찰기록 본문만 출력
- 자연스러운 한 문단으로 구성`;

async function callOpenAI(
  apiKey: string,
  modelId: string,
  activity: StudentActivity,
  targetCharCount: number
): Promise<string> {
  const userPrompt = `[제약 조건]
- 목표 글자 수: ${targetCharCount}자 (±10%)

[입력]
학번: ${activity.studentId}
이름: ${activity.studentName}
활동내용: ${activity.activityContent}

[출력]
교사관찰기록만 출력 (추가 설명 없이)`;

  const response = await requestUrl({
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });

  if (response.status !== 200) {
    throw new Error(`OpenAI API 오류: ${response.status}`);
  }

  return response.json.choices[0].message.content.trim();
}

async function callClaude(
  apiKey: string,
  modelId: string,
  activity: StudentActivity,
  targetCharCount: number
): Promise<string> {
  const userPrompt = `[제약 조건]
- 목표 글자 수: ${targetCharCount}자 (±10%)

[입력]
학번: ${activity.studentId}
이름: ${activity.studentName}
활동내용: ${activity.activityContent}

[출력]
교사관찰기록만 출력 (추가 설명 없이)`;

  const response = await requestUrl({
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId || 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (response.status !== 200) {
    throw new Error(`Claude API 오류: ${response.status}`);
  }

  return response.json.content[0].text.trim();
}

async function callGemini(
  apiKey: string,
  modelId: string,
  activity: StudentActivity,
  targetCharCount: number
): Promise<string> {
  const userPrompt = `${SYSTEM_PROMPT}

[제약 조건]
- 목표 글자 수: ${targetCharCount}자 (±10%)

[입력]
학번: ${activity.studentId}
이름: ${activity.studentName}
활동내용: ${activity.activityContent}

[출력]
교사관찰기록만 출력 (추가 설명 없이)`;

  const response = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId || 'gemini-1.5-flash'}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: userPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2000,
      },
    }),
  });

  if (response.status !== 200) {
    throw new Error(`Gemini API 오류: ${response.status}`);
  }

  return response.json.candidates[0].content.parts[0].text.trim();
}

async function callGrok(
  apiKey: string,
  modelId: string,
  activity: StudentActivity,
  targetCharCount: number
): Promise<string> {
  const userPrompt = `[제약 조건]
- 목표 글자 수: ${targetCharCount}자 (±10%)

[입력]
학번: ${activity.studentId}
이름: ${activity.studentName}
활동내용: ${activity.activityContent}

[출력]
교사관찰기록만 출력 (추가 설명 없이)`;

  // Grok API는 OpenAI 호환 형식 사용
  const response = await requestUrl({
    url: 'https://api.x.ai/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId || 'grok-3-fast',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });

  if (response.status !== 200) {
    throw new Error(`Grok API 오류: ${response.status}`);
  }

  return response.json.choices[0].message.content.trim();
}

// ==================== Input Modal ====================

class InputModal extends Modal {
  plugin: StudentActivityPlugin;
  inputData: string = '';
  targetCharCount: number;
  onSubmit: (data: string, charCount: number) => void;

  constructor(
    app: App,
    plugin: StudentActivityPlugin,
    onSubmit: (data: string, charCount: number) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.targetCharCount = plugin.settings.targetCharCount;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('student-activity-modal');

    contentEl.createEl('h2', { text: '학생활동 → 교사관찰기록 변환' });

    // 입력 안내
    contentEl.createEl('p', {
      text: '구글 스프레드시트에서 복사한 데이터를 붙여넣으세요. (학번 탭 이름 탭 활동내용)',
      cls: 'student-activity-description',
    });

    // 텍스트 영역
    const textAreaContainer = contentEl.createDiv({ cls: 'student-activity-textarea-container' });
    const textArea = textAreaContainer.createEl('textarea', {
      cls: 'student-activity-textarea',
      attr: { rows: '10', placeholder: '10101\t김철수\t프로젝트 활동에서 리더 역할을 맡아...\n10102\t이영희\t토론 수업에서 적극적으로 참여하여...' },
    });
    textArea.addEventListener('input', (e) => {
      this.inputData = (e.target as HTMLTextAreaElement).value;
      this.updatePreview();
    });

    // 미리보기 영역
    const previewContainer = contentEl.createDiv({ cls: 'student-activity-preview' });
    previewContainer.createEl('h4', { text: '입력 데이터 미리보기' });
    const previewContent = previewContainer.createDiv({ cls: 'student-activity-preview-content' });
    previewContent.setText('데이터를 입력하면 여기에 미리보기가 표시됩니다.');

    // 글자수 설정
    const charCountContainer = contentEl.createDiv({ cls: 'student-activity-char-count' });

    new Setting(charCountContainer)
      .setName('목표 글자 수')
      .setDesc('생성될 교사관찰기록의 목표 글자 수를 설정합니다.')
      .addText((text) => {
        text
          .setValue(String(this.targetCharCount))
          .onChange((value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.targetCharCount = num;
              this.updateByteEstimate();
            }
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '100';
        text.inputEl.max = '2000';
      });

    // 예상 바이트수 표시
    const byteEstimateEl = charCountContainer.createDiv({ cls: 'student-activity-byte-estimate' });
    byteEstimateEl.setText(`예상 바이트 수: ${estimateBytes(this.targetCharCount)} 바이트`);

    // 버튼 컨테이너
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: '취소',
      cls: 'student-activity-cancel-btn'
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });

    const submitBtn = buttonContainer.createEl('button', {
      text: '교사관찰기록 생성',
      cls: 'mod-cta student-activity-submit-btn',
    });
    submitBtn.addEventListener('click', () => {
      if (!this.inputData.trim()) {
        new Notice('데이터를 입력해주세요.');
        return;
      }
      const activities = parseTSV(this.inputData);
      if (activities.length === 0) {
        new Notice('유효한 데이터가 없습니다. 형식: 학번 [탭] 이름 [탭] 활동내용');
        return;
      }
      this.onSubmit(this.inputData, this.targetCharCount);
      this.close();
    });
  }

  updatePreview() {
    const previewContent = this.contentEl.querySelector('.student-activity-preview-content');
    if (!previewContent) return;

    const activities = parseTSV(this.inputData);
    if (activities.length === 0) {
      previewContent.setText('유효한 데이터가 없습니다. 형식: 학번 탭 이름 탭 활동내용');
      return;
    }

    let preview = `총 ${activities.length}명의 학생 데이터:\n\n`;
    for (const activity of activities.slice(0, 5)) {
      preview += `- ${activity.studentId} ${activity.studentName}: ${activity.activityContent.substring(0, 50)}...\n`;
    }
    if (activities.length > 5) {
      preview += `\n... 외 ${activities.length - 5}명`;
    }

    previewContent.setText(preview);
  }

  updateByteEstimate() {
    const byteEstimateEl = this.contentEl.querySelector('.student-activity-byte-estimate');
    if (byteEstimateEl) {
      byteEstimateEl.setText(`예상 바이트 수: ${estimateBytes(this.targetCharCount)} 바이트`);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ==================== Progress Modal ====================

class ProgressModal extends Modal {
  progressText: HTMLElement | null = null;
  progressBar: HTMLElement | null = null;
  progressBarFill: HTMLElement | null = null;
  progressPercentText: HTMLElement | null = null;
  statusText: HTMLElement | null = null;
  studentListContainer: HTMLElement | null = null;
  currentIndex: number = 0;
  totalCount: number = 0;
  completedStudents: string[] = [];
  previousStudentName: string = '';

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('student-activity-progress-modal');

    // 헤더 영역
    const headerDiv = contentEl.createDiv({ cls: 'progress-header' });
    const iconSpan = headerDiv.createSpan({ cls: 'progress-icon' });
    iconSpan.innerHTML = '✨';
    headerDiv.createEl('h2', { text: '교사관찰기록 생성 중' });

    // 현재 처리 중인 학생 정보 (강조)
    this.progressText = contentEl.createEl('p', { cls: 'progress-text' });
    this.progressText.setText('AI 변환 준비 중...');

    // 프로그레스 바 컨테이너 (원형 퍼센트 포함)
    const progressWrapper = contentEl.createDiv({ cls: 'progress-wrapper' });

    // 원형 프로그레스 표시
    const circleContainer = progressWrapper.createDiv({ cls: 'progress-circle-container' });
    this.progressPercentText = circleContainer.createDiv({ cls: 'progress-circle' });
    this.progressPercentText.setText('0%');

    // 바형 프로그레스
    const barSection = progressWrapper.createDiv({ cls: 'progress-bar-section' });
    const progressBarContainer = barSection.createDiv({ cls: 'progress-bar-container' });
    this.progressBar = progressBarContainer.createDiv({ cls: 'progress-bar-bg' });
    this.progressBarFill = this.progressBar.createDiv({ cls: 'progress-bar-fill' });
    this.progressBarFill.style.width = '0%';

    // 진행 단계 표시
    this.statusText = barSection.createEl('p', { cls: 'progress-status' });
    this.statusText.setText('잠시만 기다려주세요...');

    // 완료된 학생 목록 (스크롤 가능)
    const listSection = contentEl.createDiv({ cls: 'progress-list-section' });
    listSection.createEl('h4', { text: '📝 변환 완료' });
    this.studentListContainer = listSection.createDiv({ cls: 'progress-student-list' });

    // 안내 메시지
    const infoText = contentEl.createEl('p', { cls: 'progress-info' });
    infoText.innerHTML = '🤖 AI가 학생활동 내용을 <strong>교사관찰기록 문체</strong>로 변환하고 있습니다.';
  }

  updateProgress(current: number, total: number, studentName: string) {
    this.currentIndex = current;
    this.totalCount = total;
    const percentage = Math.round((current / total) * 100);

    if (this.progressText) {
      this.progressText.innerHTML = `<span class="current-student">🎯 ${studentName}</span> 변환 중... <span class="progress-count">(${current}/${total}명)</span>`;
    }
    if (this.progressBarFill) {
      this.progressBarFill.style.width = `${percentage}%`;
      // 동적 색상 변화
      if (percentage < 30) {
        this.progressBarFill.style.background = 'linear-gradient(90deg, #ff6b6b, #ffa502)';
      } else if (percentage < 70) {
        this.progressBarFill.style.background = 'linear-gradient(90deg, #ffa502, #2ed573)';
      } else {
        this.progressBarFill.style.background = 'linear-gradient(90deg, #2ed573, #1e90ff)';
      }
    }
    if (this.progressPercentText) {
      this.progressPercentText.setText(`${percentage}%`);
      this.progressPercentText.style.background = `conic-gradient(var(--interactive-accent) ${percentage * 3.6}deg, var(--background-modifier-border) 0deg)`;
    }
    if (this.statusText) {
      if (current === total) {
        this.statusText.innerHTML = '✅ 변환 완료! 결과를 저장하고 있습니다...';
      } else {
        const remaining = total - current;
        const estimatedTime = remaining * 2; // 약 2초/명 예상
        this.statusText.innerHTML = `⏳ 남은 학생: <strong>${remaining}명</strong> (예상 ${estimatedTime}초)`;
      }
    }

    // 이전 학생이 완료되었으므로 이전 학생 이름을 목록에 추가
    if (this.previousStudentName && this.studentListContainer) {
      const studentTag = this.studentListContainer.createSpan({ cls: 'completed-student-tag' });
      studentTag.setText(`✓ ${this.previousStudentName}`);
      // 스크롤을 최신 항목으로
      this.studentListContainer.scrollTop = this.studentListContainer.scrollHeight;
    }
    // 현재 학생 이름 저장 (다음 호출 시 완료 처리용)
    this.previousStudentName = studentName;
  }

  // 마지막 학생 완료 처리
  markLastStudentComplete() {
    if (this.previousStudentName && this.studentListContainer) {
      const studentTag = this.studentListContainer.createSpan({ cls: 'completed-student-tag' });
      studentTag.setText(`✓ ${this.previousStudentName}`);
      this.studentListContainer.scrollTop = this.studentListContainer.scrollHeight;
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ==================== Settings Tab ====================

class StudentActivitySettingTab extends PluginSettingTab {
  plugin: StudentActivityPlugin;
  modelDropdown: any = null;

  constructor(app: App, plugin: StudentActivityPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getProviderName(provider: string): string {
    const names: Record<string, string> = {
      openai: 'OpenAI',
      claude: 'Anthropic',
      gemini: 'Google',
      grok: 'xAI',
    };
    return names[provider] || provider;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h1', { text: '학생활동 → 교사관찰기록 변환 설정' });

    // API 제공자 선택
    new Setting(containerEl)
      .setName('AI 제공자')
      .setDesc('사용할 AI API 제공자를 선택합니다.')
      .addDropdown((dropdown) => {
        dropdown.addOption('openai', 'OpenAI (GPT)');
        dropdown.addOption('claude', 'Anthropic (Claude)');
        dropdown.addOption('gemini', 'Google (Gemini)');
        dropdown.addOption('grok', 'xAI (Grok)');
        dropdown.setValue(this.plugin.settings.apiProvider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.apiProvider = value as 'openai' | 'claude' | 'gemini' | 'grok';
          // 제공자 변경 시 기본 모델로 설정
          this.plugin.settings.modelId = DEFAULT_MODELS[value];
          await this.plugin.saveSettings();
          this.display(); // 설정 화면 새로고침
        });
      });

    // API 키
    const apiKeyPlaceholders: Record<string, string> = {
      openai: 'sk-...',
      claude: 'sk-ant-...',
      gemini: 'AIza...',
      grok: 'xai-...',
    };

    new Setting(containerEl)
      .setName('API 키')
      .setDesc(`${this.getProviderName(this.plugin.settings.apiProvider)} API 키를 입력합니다.`)
      .addText((text) =>
        text
          .setPlaceholder(apiKeyPlaceholders[this.plugin.settings.apiProvider] || 'API 키')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    // 모델 ID (드롭다운)
    const currentProvider = this.plugin.settings.apiProvider;
    const models = MODEL_OPTIONS[currentProvider] || [];

    new Setting(containerEl)
      .setName('모델')
      .setDesc(`${this.getProviderName(currentProvider)}에서 사용할 AI 모델을 선택합니다.`)
      .addDropdown((dropdown) => {
        this.modelDropdown = dropdown;
        for (const model of models) {
          dropdown.addOption(model.id, model.name);
        }
        // 현재 설정된 모델이 목록에 있는지 확인
        const modelExists = models.some(m => m.id === this.plugin.settings.modelId);
        if (modelExists) {
          dropdown.setValue(this.plugin.settings.modelId);
        } else {
          // 목록에 없으면 기본 모델로 설정
          dropdown.setValue(DEFAULT_MODELS[currentProvider]);
          this.plugin.settings.modelId = DEFAULT_MODELS[currentProvider];
          this.plugin.saveSettings();
        }
        dropdown.onChange(async (value) => {
          this.plugin.settings.modelId = value;
          await this.plugin.saveSettings();
        });
      });

    // 기본 글자 수
    new Setting(containerEl)
      .setName('기본 목표 글자 수')
      .setDesc('교사관찰기록의 기본 목표 글자 수를 설정합니다.')
      .addText((text) => {
        text
          .setPlaceholder('500')
          .setValue(String(this.plugin.settings.targetCharCount))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.targetCharCount = num;
              await this.plugin.saveSettings();
            }
          });
        text.inputEl.type = 'number';
      });

    // 출력 폴더
    new Setting(containerEl)
      .setName('결과 저장 폴더')
      .setDesc('변환 결과를 저장할 폴더 경로 (비워두면 Vault 루트에 저장)')
      .addText((text) =>
        text
          .setPlaceholder('교사관찰기록')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value;
            await this.plugin.saveSettings();
          })
      );

    // NEIS 글자수/바이트수 안내
    containerEl.createEl('h2', { text: 'NEIS 글자수/바이트수 계산 기준' });
    const infoDiv = containerEl.createDiv({ cls: 'student-activity-info' });
    infoDiv.innerHTML = `
      <ul>
        <li><strong>글자 수</strong>: 모든 문자를 1개로 계산 (한글, 영문, 숫자, 공백, 특수문자)</li>
        <li><strong>바이트 수</strong>:
          <ul>
            <li>한글, 한자: 3바이트</li>
            <li>영문, 숫자, 특수문자, 공백, 줄바꿈: 1바이트</li>
          </ul>
        </li>
      </ul>
    `;
  }
}

// ==================== Main Plugin Class ====================

export default class StudentActivityPlugin extends Plugin {
  settings: StudentActivityPluginSettings;

  async onload(): Promise<void> {
    console.log('Loading Student Activity to Observation Plugin');

    await this.loadSettings();

    this.addSettingTab(new StudentActivitySettingTab(this.app, this));

    // 커맨드: Modal 열기
    this.addCommand({
      id: 'open-conversion-modal',
      name: '학생활동 → 교사관찰기록 변환 (Modal)',
      callback: () => {
        this.openConversionModal();
      },
    });

    // 커맨드: 선택 영역에서 변환
    this.addCommand({
      id: 'convert-from-selection',
      name: '선택 영역에서 교사관찰기록 변환',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          new Notice('텍스트를 선택해주세요.');
          return;
        }
        this.processConversion(selection, this.settings.targetCharCount);
      },
    });

    // 파일 메뉴 추가
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle('학생활동 → 교사관찰기록 변환')
            .setIcon('file-text')
            .onClick(() => {
              this.openConversionModal();
            });
        });
      })
    );
  }

  async onunload(): Promise<void> {
    console.log('Unloading Student Activity to Observation Plugin');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  openConversionModal() {
    if (!this.settings.apiKey) {
      new Notice('API 키를 설정해주세요. (설정 → 학생활동 → 교사관찰기록 변환)');
      return;
    }

    new InputModal(this.app, this, (data, charCount) => {
      this.processConversion(data, charCount);
    }).open();
  }

  async processConversion(data: string, targetCharCount: number) {
    const activities = parseTSV(data);

    if (activities.length === 0) {
      new Notice('변환할 데이터가 없습니다.');
      return;
    }

    const progressModal = new ProgressModal(this.app);
    progressModal.open();

    const records: ObservationRecord[] = [];
    let errorCount = 0;

    for (let i = 0; i < activities.length; i++) {
      const activity = activities[i];
      progressModal.updateProgress(i + 1, activities.length, activity.studentName);

      try {
        let observation: string;

        switch (this.settings.apiProvider) {
          case 'openai':
            observation = await callOpenAI(
              this.settings.apiKey,
              this.settings.modelId || DEFAULT_MODELS.openai,
              activity,
              targetCharCount
            );
            break;
          case 'claude':
            observation = await callClaude(
              this.settings.apiKey,
              this.settings.modelId || DEFAULT_MODELS.claude,
              activity,
              targetCharCount
            );
            break;
          case 'gemini':
            observation = await callGemini(
              this.settings.apiKey,
              this.settings.modelId || DEFAULT_MODELS.gemini,
              activity,
              targetCharCount
            );
            break;
          case 'grok':
            observation = await callGrok(
              this.settings.apiKey,
              this.settings.modelId || DEFAULT_MODELS.grok,
              activity,
              targetCharCount
            );
            break;
          default:
            throw new Error(`지원하지 않는 AI 제공자: ${this.settings.apiProvider}`);
        }

        records.push({
          studentId: activity.studentId,
          studentName: activity.studentName,
          activityContent: activity.activityContent,
          observation: observation,
          charCount: countChars(observation),
          byteCount: countBytes(observation),
        });
      } catch (error) {
        console.error(`Error processing ${activity.studentName}:`, error);
        errorCount++;
        records.push({
          studentId: activity.studentId,
          studentName: activity.studentName,
          activityContent: activity.activityContent,
          observation: `[변환 실패: ${error instanceof Error ? error.message : '알 수 없는 오류'}]`,
          charCount: 0,
          byteCount: 0,
        });
      }

      // API 호출 간 딜레이 (rate limit 방지)
      if (i < activities.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 마지막 학생 완료 표시
    progressModal.markLastStudentComplete();
    progressModal.close();

    // 결과 노트 생성
    await this.createResultNote(records);

    if (errorCount > 0) {
      new Notice(`변환 완료! (${records.length - errorCount}명 성공, ${errorCount}명 실패)`);
    } else {
      new Notice(`${records.length}명의 교사관찰기록 변환 완료!`);
    }
  }

  async createResultNote(records: ObservationRecord[]) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '');

    const fileName = `교사관찰기록_${dateStr}_${timeStr}.md`;
    let filePath = fileName;

    if (this.settings.outputFolder) {
      // 폴더가 없으면 생성
      const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
      if (!folder) {
        await this.app.vault.createFolder(this.settings.outputFolder);
      }
      filePath = `${this.settings.outputFolder}/${fileName}`;
    }

    // TSV 데이터를 base64로 인코딩하여 저장 (복사 버튼용)
    const tsvData = generateTSVData(records);
    const encodedTSV = Buffer.from(tsvData).toString('base64');

    const content = `# 교사관찰기록 변환 결과

생성일시: ${now.toLocaleString('ko-KR')}
총 인원: ${records.length}명

## 📋 구글 스프레드시트로 복사

<div class="student-activity-copy-section">
<button class="student-activity-copy-btn" data-tsv="${encodedTSV}">
📋 클릭하여 복사하기
</button>
<span class="copy-status"></span>
</div>

> 위 버튼을 클릭하면 TSV 데이터가 클립보드에 복사됩니다.
> 구글 스프레드시트에서 Ctrl+V로 붙여넣으면 열이 자동으로 구분됩니다.

---

## 결과 테이블

${generateMarkdownTable(records)}

## 통계

| 항목 | 값 |
|------|-----|
| 총 인원 | ${records.length}명 |
| 평균 글자 수 | ${Math.round(records.reduce((sum, r) => sum + r.charCount, 0) / records.length)}자 |
| 평균 바이트 수 | ${Math.round(records.reduce((sum, r) => sum + r.byteCount, 0) / records.length)} 바이트 |
`;

    const file = await this.app.vault.create(filePath, content);

    // 생성된 파일 열기
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);

    // 복사 버튼 이벤트 등록
    this.registerCopyButtonHandler();
  }

  registerCopyButtonHandler() {
    // DOM이 준비될 때까지 약간의 딜레이
    setTimeout(() => {
      const copyButtons = document.querySelectorAll('.student-activity-copy-btn');
      copyButtons.forEach((btn) => {
        if (btn.hasAttribute('data-listener-attached')) return;
        btn.setAttribute('data-listener-attached', 'true');

        btn.addEventListener('click', async (e) => {
          const button = e.target as HTMLElement;
          const encodedTSV = button.getAttribute('data-tsv');
          if (!encodedTSV) return;

          try {
            const tsvData = Buffer.from(encodedTSV, 'base64').toString('utf-8');
            await navigator.clipboard.writeText(tsvData);

            // 버튼 상태 변경
            const originalText = button.textContent;
            button.textContent = '✅ 복사 완료!';
            button.classList.add('copied');

            new Notice('📋 클립보드에 복사되었습니다! 구글 스프레드시트에 붙여넣기(Ctrl+V)하세요.');

            setTimeout(() => {
              button.textContent = originalText;
              button.classList.remove('copied');
            }, 2000);
          } catch (error) {
            new Notice('복사 실패: ' + (error instanceof Error ? error.message : '알 수 없는 오류'));
          }
        });
      });
    }, 500);
  }
}
