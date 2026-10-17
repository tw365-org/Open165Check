export const NORMAL = '正常訊息';
export const CONFIG_VERSION = '2026-10-17-v1';
export const CATEGORY_CRITERIA: Record<string, string> = {
  '釣魚連結': '要求點擊連結、掃描 QR Code 或填寫表單，假冒物流、稅務、電信、銀行通知',
  '假機構服務通知': '假冒電信、銀行、信用卡中心、醫院等機構，以異常、欠費、個資外洩為由要求處理',
  '假客服解除分期': '假冒電商或銀行客服，聲稱誤設分期或重複扣款，要求到 ATM 或網銀操作',
  '假公權力': '假冒檢察官、警察、法院，以涉案、洗錢為由要求保密、匯款或交出帳戶',
  '假投資': '以老師帶單、保證獲利、投資群組等方式誘導入金',
  '假交友': '透過交友或社群關係建立感情後，誘導下載 APP 或一起投資',
  '熟人冒充': '冒充親友或使用新號碼，以急用為由要求借錢或匯款',
  '網購交易陷阱': '假冒購物、賣貨便或包裹通知，誘導付款或私下交易',
  '假買家騙賣家': '假冒買家，以系統鎖定或認證為由要求賣家操作分享畫面或離開平台',
  '假求職': '以高薪兼職為誘餌，要求先付費、先購買物品或提供帳戶資料',
  [NORMAL]: '正常訊息，不屬於上述任何詐騙態樣',
};
export const SIGNALS: Record<string, string> = {
  demand_link: '這則訊息是否要求點擊連結、開啟網址或掃描 QR Code？',
  demand_card_info: '這則訊息是否要求輸入卡號、密碼、驗證碼或個人證件資料？',
  demand_transfer: '這則訊息是否要求匯款、轉帳或提供存款資訊？',
  off_platform: '這則訊息是否要求離開原平台或改用私訊、其他通訊軟體交易？',
  demand_app_install: '這則訊息是否要求下載指定 APP？',
  impersonate_authority: '這則訊息是否冒充政府機關、檢警、銀行、電信或客服？',
  impersonate_relation: '這則訊息是否冒充親友或家人？',
  urgency: '這則訊息是否製造急迫感或催促立即行動？',
  threat: '這則訊息是否以凍結、涉案、影響車籍等後果施壓？',
  secrecy: '這則訊息是否要求保密或不可告知家人？',
  guaranteed_return: '這則訊息是否承諾保證獲利或高額回報？',
  upfront_payment: '這則訊息是否要求先付費、保證金、稅金或購買物品？',
};
export const SIGNAL_LABELS: Record<string, string> = {
  demand_link: '點擊連結', demand_card_info: '索取敏感資料', demand_transfer: '要求轉帳',
  off_platform: '離開原平台', demand_app_install: '下載 APP', impersonate_authority: '機構偽冒',
  impersonate_relation: '親友偽冒', urgency: '急迫催促', threat: '威脅施壓', secrecy: '要求保密',
  guaranteed_return: '保證獲利', upfront_payment: '預付費用',
};
export function buildQuestions() {
  return { category: { type: 'choice', instructions: '這則訊息最符合下列哪一種詐騙態樣？若不屬於任何詐騙態樣，請選「正常訊息」。', criteria: CATEGORY_CRITERIA },
    ...Object.fromEntries(Object.entries(SIGNALS).map(([k, instructions]) => [k, { type: 'noul', instructions }])) };
}
export interface Sample { id: string; text: string; label: 'scam' | 'legit'; category: string; variant: string }
export interface Classification { choice: string; p_scam: number; probabilities: Record<string, number>; signals: Record<string, number>; model: string; usage: { input_tokens: number; output_tokens: number } }
export interface EvalRecord extends Omit<Sample, 'text'> { text: string | null; choice: string | null; p_scam: number | null; error: string | null }
