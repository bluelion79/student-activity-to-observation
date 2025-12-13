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
  apiProvider: 'openai' | 'claude';
  apiKey: string;
  targetCharCount: number;
  outputFolder: string;
  modelId: string;
}

interface StudentActivity {
  studentId: string;
  studentName: string;
  activityContent: string;
}

interface ObservationRecord {
  studentId: string;
  studentName: string;
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
 * NEIS 기준 바이트 수 계산
 * - 한글: 3바이트
 * - 영문/숫자/특수문자/공백: 1바이트
 */
function countBytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
      (code >= 0x1100 && code <= 0x11ff) || // 한글 자모
      (code >= 0x3130 && code <= 0x318f) || // 한글 호환 자모
      (code >= 0x4e00 && code <= 0x9fff) || // 한자
      (code >= 0xf900 && code <= 0xfaff) // 한자 호환
    ) {
      bytes += 3;
    } else {
      bytes += 1;
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
 * 마크다운 테이블 생성
 */
function generateMarkdownTable(records: ObservationRecord[]): string {
  let table = '| 학번 | 이름 | 교사관찰기록 | 글자수 | 바이트수 |\n';
  table += '|------|------|-------------|--------|----------|\n';

  for (const record of records) {
    const escapedObservation = record.observation.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    table += `| ${record.studentId} | ${record.studentName} | ${escapedObservation} | ${record.charCount} | ${record.byteCount} |\n`;
  }

  return table;
}

// ==================== AI Service ====================

const SYSTEM_PROMPT = `당신은 한국 고등학교 교사입니다. 학생의 활동 내용을 교사 관찰 기록 문체로 변환해주세요.

[문체 특징]
- "~함", "~보임", "~드러냄", "~보여줌", "~밝힘" 등의 종결어미 사용
- 학생의 역량, 태도, 성장을 강조
- 구체적인 활동 내용과 결과를 포함
- 교육적 가치와 의미를 부여

[역량 표현 예시]
- "탐구 역량", "문제 해결 능력", "협력과 소통 역량", "자기 주도적 역량"
- "깊이 있는", "우수한", "뛰어난", "인상적인", "돋보이는"

[주의사항]
- 학생 이름은 기록에 포함하지 않습니다
- 자연스럽고 진정성 있는 표현을 사용합니다
- 추가 설명 없이 교사관찰기록만 출력합니다`;

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

    buttonContainer.createEl('button', { text: '취소' }).addEventListener('click', () => {
      this.close();
    });

    const submitBtn = buttonContainer.createEl('button', {
      text: '변환 시작',
      cls: 'mod-cta',
    });
    submitBtn.addEventListener('click', () => {
      if (!this.inputData.trim()) {
        new Notice('데이터를 입력해주세요.');
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
  currentIndex: number = 0;
  totalCount: number = 0;

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('student-activity-progress-modal');

    contentEl.createEl('h2', { text: '변환 진행 중...' });

    this.progressText = contentEl.createEl('p', { cls: 'progress-text' });
    this.progressText.setText('준비 중...');

    const progressBarContainer = contentEl.createDiv({ cls: 'progress-bar-container' });
    this.progressBar = progressBarContainer.createDiv({ cls: 'progress-bar' });
    this.progressBar.style.width = '0%';
  }

  updateProgress(current: number, total: number, studentName: string) {
    this.currentIndex = current;
    this.totalCount = total;

    if (this.progressText) {
      this.progressText.setText(`${current}/${total} - ${studentName} 변환 중...`);
    }
    if (this.progressBar) {
      const percentage = (current / total) * 100;
      this.progressBar.style.width = `${percentage}%`;
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

  constructor(app: App, plugin: StudentActivityPlugin) {
    super(app, plugin);
    this.plugin = plugin;
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
        dropdown.setValue(this.plugin.settings.apiProvider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.apiProvider = value as 'openai' | 'claude';
          await this.plugin.saveSettings();
          this.display(); // 설정 화면 새로고침
        });
      });

    // API 키
    new Setting(containerEl)
      .setName('API 키')
      .setDesc(`${this.plugin.settings.apiProvider === 'openai' ? 'OpenAI' : 'Anthropic'} API 키를 입력합니다.`)
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    // 모델 ID
    new Setting(containerEl)
      .setName('모델 ID')
      .setDesc(
        this.plugin.settings.apiProvider === 'openai'
          ? 'OpenAI 모델 ID (예: gpt-4o, gpt-4o-mini)'
          : 'Claude 모델 ID (예: claude-3-5-sonnet-20241022)'
      )
      .addText((text) =>
        text
          .setPlaceholder(
            this.plugin.settings.apiProvider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-20241022'
          )
          .setValue(this.plugin.settings.modelId)
          .onChange(async (value) => {
            this.plugin.settings.modelId = value;
            await this.plugin.saveSettings();
          })
      );

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

        if (this.settings.apiProvider === 'openai') {
          observation = await callOpenAI(
            this.settings.apiKey,
            this.settings.modelId || 'gpt-4o-mini',
            activity,
            targetCharCount
          );
        } else {
          observation = await callClaude(
            this.settings.apiKey,
            this.settings.modelId || 'claude-3-5-sonnet-20241022',
            activity,
            targetCharCount
          );
        }

        records.push({
          studentId: activity.studentId,
          studentName: activity.studentName,
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

    const content = `# 교사관찰기록 변환 결과

생성일시: ${now.toLocaleString('ko-KR')}
총 인원: ${records.length}명

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
  }
}
