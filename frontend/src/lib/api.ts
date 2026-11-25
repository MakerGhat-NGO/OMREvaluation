// Small wrapper around fetch for the JSON API. Errors carry the server's message.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Once the sign-in runs out (App Service ends it after 8 hours), App Service answers with a redirect to
// the Microsoft sign-in page. fetch would follow it to another site and fail as if the connection were
// lost. Marked as AJAX, App Service answers with an empty 401 or 403 instead (the live app gives 403);
// redirect: 'manual' turns a redirect that still comes into a 401 as well. Either way every screen says
// "You have been signed out".
const AJAX = { 'X-Requested-With': 'XMLHttpRequest' };
const SEND_JSON = { ...AJAX, 'Content-Type': 'application/json' };
const BASE: RequestInit = { credentials: 'same-origin', redirect: 'manual' };

async function handle<T>(res: Response): Promise<T> {
  if (res.type === 'opaqueredirect') throw new ApiError(401, 'you are signed out');
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    // The app's own 401 and 403 always say why in JSON. Without that, App Service sent it: signed out.
    if ((res.status === 401 || res.status === 403) && !(body && body.error)) throw new ApiError(401, 'you are signed out');
    const msg = (body && body.error) || res.statusText || `request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const api = {
  get: <T>(url: string) => fetch(url, { ...BASE, headers: AJAX }).then(r => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, { ...BASE, method: 'POST', headers: SEND_JSON,
      body: body === undefined ? undefined : JSON.stringify(body) }).then(r => handle<T>(r)),
  put: <T>(url: string, body: unknown) =>
    fetch(url, { ...BASE, method: 'PUT', headers: SEND_JSON, body: JSON.stringify(body) }).then(r => handle<T>(r)),
  patch: <T>(url: string, body: unknown) =>
    fetch(url, { ...BASE, method: 'PATCH', headers: SEND_JSON, body: JSON.stringify(body) }).then(r => handle<T>(r)),
  del: (url: string) => fetch(url, { ...BASE, method: 'DELETE', headers: AJAX }).then(r => handle<void>(r)),
  // No Content-Type here: the browser writes the one for a form, with its boundary.
  upload: <T>(url: string, form: FormData) =>
    fetch(url, { ...BASE, method: 'POST', headers: AJAX, body: form }).then(r => handle<T>(r)),
};

export interface User { id: string; email: string; name: string; role: 'teacher' | 'admin'; status: 'pending' | 'approved' | 'disabled'; created_at: string; approved_by: string | null; }
export interface Me {
  signed_in: boolean; user: User; sheet: { question_count: number; field_labels: string[] };
  /** What is switched on. ignite: school details on a batch, correcting a sheet, Submit, skills. */
  features?: { ignite: boolean };
}
export interface Test { id: string; name: string; question_count: number; options: string; marks_correct: number; marks_incorrect: number; marks_unmarked: number; answer_key: Record<string, string>; created_by: string; created_at: string; archived: boolean;
  /** IGNITE: the skill each question tests ({ q1: 'Scientific Reasoning' }); empty when none are set. */
  skill_map?: Record<string, string>;
  /** IGNITE: the most a student can score in the hands-on activity; null when this key has none. */
  hands_on_max?: number | null;
  /** IGNITE: the least hands-on score that lets a student write the test (3 of 5); null when none is set. */
  hands_on_pass?: number | null;
}
/** A state (Maharashtra, say) that batches are filed under. Teachers add states as they need them. */
export interface State { id: string; name: string; created_by: string; created_at: string; }
export interface Batch {
  id: string; test_id: string; test_name: string | null;
  /** The state the batch is filed under; null on batches made before states existed. */
  state_id: string | null; state_name: string | null;
  name: string; created_by: string; created_at: string; finished_at: string | null;
  status: 'open' | 'finished'; sheet_count: number; read_count: number; review_count: number; error_count: number;
  /** Mean score of the sheets that were read; null when none were. */
  average_score: number | null;
  /** The most one sheet can score with this answer key. */
  max_score: number | null;
  // IGNITE: where and when the test was taken ('' or null when not typed), and who sent the checked
  // batch on to the admin. A sheet that is left out is in none of the counts above.
  district?: string; block?: string; school?: string; grade?: string;
  /** The schools at this session (most tests are at a central place); school is them joined. */
  schools?: string[];
  /** The day of the assessment as 2026-11-02. */
  assessed_on?: string | null;
  /** With an activity score on the answer key, the students in the hands-on challenge, typed by the
   *  teacher. Without one, the admin's own figure; null means the number of sheets. */
  students_reached?: number | null;
  submitted_at?: string | null; submitted_by?: string;
  left_out_count?: number; hands_on_count?: number;
  /** The most an activity score can be on this batch's answer key; null when it takes none. */
  hands_on_max?: number | null;
}
/** One reading of a sheet: what the first reading was, before anyone corrected it. */
export interface Reading {
  status: 'ok' | 'error'; error_reason: string; fields: Record<string, string>; answers: Record<string, string>;
  score: number | null; needs_review: boolean; review_reason: string;
}
/** One save of a corrected sheet: who, when, and each thing that changed. */
export interface SheetChange {
  by: string; at: string;
  changes: { what: string; from: string | number | boolean | null; to: string | number | boolean | null }[];
}
/** How many of one skill's questions a student got right. */
export interface SkillScore { skill: string; correct: number; total: number; }
export interface Sheet {
  id: string; batch_id: string; source_name: string; page_no: number; status: 'ok' | 'error'; error_reason: string;
  fields: Record<string, string>; answers: Record<string, string>; score: number | null; needs_review: boolean;
  review_reason: string; has_checked_image: boolean; created_at: string;
  /** Email of the person who checked it; '' on sheets checked before this was kept. */
  created_by: string;
  // IGNITE
  hands_on_score?: number | null;
  /** Left out of the results (a page scanned twice, a blank page). */
  left_out?: boolean;
  /** Could not be read, so a person typed it in from the paper. */
  entered_by_hand?: boolean;
  /** Who said a sheet that needed a check is right now; '' when nobody has. */
  confirmed_by?: string; confirmed_at?: string | null;
  /** The first reading, once the reading has been corrected. */
  original?: Reading;
  changes?: SheetChange[];
  /** Right answers per skill, when the answer key has skills. */
  skills?: SkillScore[];
}
/** The districts, blocks, schools and grades typed on earlier batches, to suggest while typing. */
export interface Places {
  /** status: what an admin marked a block of the programme ("Completed", ...); '' for the rest. */
  places: { state_id: string; district: string; block: string; school: string; status?: string }[];
  grades: string[];
}
/** Where each question (q1..q50) and field (Name, Roll Number, Mobile Number, gender) sits on the
 *  checked picture: [left, top, right, bottom] as fractions of the picture's width and height. */
export interface SheetLayout { boxes: Record<string, [number, number, number, number]>; }

/** URLs of the two pictures kept for every sheet. */
export const sheetImageUrl = (sheetId: string, kind: 'checked' | 'input' = 'checked') =>
  `/api/sheets/${sheetId}/image${kind === 'input' ? '?kind=input' : ''}`;
