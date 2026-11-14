export type Playable = 'yes' | 'maybe' | 'no'

export interface CourseSummary {
  id: number
  title: string
  channel: string | null
  thumb_url: string
  lesson_count: number
  total_duration_s: number
  completed_count: number
  notes_count: number
  last_watched_at: string | null
}

export interface LessonRow {
  id: number
  title: string
  section_id: number | null
  section_title: string | null
  duration_s: number | null
  playable: Playable
  completed: number
  position_s: number
  notes_count: number
  thumb_url: string
}

export interface Section {
  id: number | null
  title: string | null
  lessons: LessonRow[]
}

export interface CourseDetail {
  id: number
  title: string
  description: string | null
  channel: string | null
  youtube_id: string | null
  path: string
  thumb_url: string
  sections: Section[]
  lesson_count: number
  completed_count: number
  total_duration_s: number
  notes_count: number
  resume_lesson_id: number | null
}

export interface Chapter {
  start_s: number
  end_s: number | null
  title: string
}

export interface Subtitle {
  index: number
  label: string
  lang: string
  url: string
}

export interface LessonDetail {
  id: number
  title: string
  description: string | null
  channel: string | null
  upload_date: string | null
  youtube_id: string | null
  duration_s: number | null
  width: number | null
  height: number | null
  vcodec: string | null
  acodec: string | null
  playable: Playable
  missing: boolean
  meta_source: string | null
  file_name: string
  stream_url: string
  thumb_url: string
  course: { id: number; title: string }
  section_title: string | null
  chapters: Chapter[]
  subtitles: Subtitle[]
  progress: { position_s: number; completed: number; last_watched_at: string | null }
  prev: { id: number; title: string } | null
  next: { id: number; title: string } | null
  index: number
  total: number
}

export interface Note {
  id: number
  lesson_id: number
  timestamp_s: number
  body_md: string
  created_at: string
  updated_at: string
}

export interface CourseNote extends Note {
  lesson_title: string
  section_title: string | null
}

export interface ContinueItem {
  lesson_id: number
  title: string
  course_id: number
  course_title: string
  duration_s: number | null
  position_s: number
  thumb_url: string
  last_watched_at: string
}

export interface SearchResult {
  courses: { id: number; title: string }[]
  lessons: { id: number; title: string; course_title: string; duration_s: number | null; thumb_url: string }[]
  notes: {
    id: number
    lesson_id: number
    timestamp_s: number
    snippet: string
    lesson_title: string
    course_title: string
    course_id: number
  }[]
}

export interface Library {
  id: number
  path: string
  name: string
  mode: 'collection' | 'course'
  enabled: boolean
  course_count: number
  exists: boolean
}

export interface ScanStatus {
  running: boolean
  processed: number
  total: number
  added: number
  updated: number
  relinked: number
  missing: number
  errors: string[]
  error: string | null
  started_at: string | null
  finished_at: string | null
}

export interface MountedFolder {
  path: string
  name: string
  is_library: boolean
  suggested_mode: Library['mode']
}

export interface BrowseResult {
  path: string
  parent: string | null
  dirs: string[]
}

export interface Me {
  username: string
  is_admin: boolean
}

export interface SecuritySummary {
  alert: boolean
  reasons: string[]
  last_24h: Record<string, number>
  last_7d: Record<string, number>
  top_ips: { ip: string; n: number; last_at: string }[]
}

export interface SecurityEvent {
  id: number
  first_at: string
  at: string
  kind: string
  ip: string | null
  username: string | null
  path: string | null
  count: number
}

export interface AppUser {
  username: string
  is_admin: boolean
  source: 'compose' | 'app'
  mode?: 'all' | 'selected'
  course_ids?: number[]
}

export interface AdminCourse {
  id: number
  title: string
  library: string | null
  lesson_count: number
}

/** Fired when any API call answers 401 (session expired / logged out elsewhere). */
export const UNAUTHORIZED_EVENT = 'edunest:unauthorized'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j?.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* not json */
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const api = {
  me: () => req<Me>('/api/auth/me'),
  login: (username: string, password: string) => req<Me>('/api/auth/login', json('POST', { username, password })),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  users: () => req<AppUser[]>('/api/users'),
  createUser: (username: string, password: string) => req<AppUser>('/api/users', json('POST', { username, password })),
  deleteUser: (username: string) => req<void>(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  resetPassword: (username: string, password: string) =>
    req<{ ok: boolean }>(`/api/users/${encodeURIComponent(username)}/password`, json('PUT', { password })),
  setAccess: (username: string, mode: 'all' | 'selected', course_ids: number[]) =>
    req<AppUser>(`/api/users/${encodeURIComponent(username)}/access`, json('PUT', { mode, course_ids })),
  adminCourses: () => req<AdminCourse[]>('/api/admin/courses'),
  securitySummary: () => req<SecuritySummary>('/api/security/summary'),
  securityEvents: (limit = 100) => req<SecurityEvent[]>(`/api/security/events?limit=${limit}`),
  clearSecurityEvents: () => req<void>('/api/security/events', { method: 'DELETE' }),

  courses: () => req<CourseSummary[]>('/api/courses'),
  course: (id: number) => req<CourseDetail>(`/api/courses/${id}`),
  courseNotes: (id: number) => req<CourseNote[]>(`/api/courses/${id}/notes`),
  lesson: (id: number) => req<LessonDetail>(`/api/lessons/${id}`),
  continueWatching: () => req<ContinueItem[]>('/api/continue-watching'),
  saveProgress: (id: number, position_s: number, completed?: boolean) =>
    req<{ completed: boolean }>(`/api/progress/${id}`, json('PUT', { position_s, completed })),

  notes: (lessonId: number) => req<Note[]>(`/api/lessons/${lessonId}/notes`),
  createNote: (lessonId: number, timestamp_s: number, body_md: string) =>
    req<Note>(`/api/lessons/${lessonId}/notes`, json('POST', { timestamp_s, body_md })),
  updateNote: (id: number, patch: Partial<Pick<Note, 'timestamp_s' | 'body_md'>>) =>
    req<Note>(`/api/notes/${id}`, json('PATCH', patch)),
  deleteNote: (id: number) => req<void>(`/api/notes/${id}`, { method: 'DELETE' }),

  search: (q: string) => req<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`),

  libraries: () => req<Library[]>('/api/libraries'),
  addLibrary: (path: string, mode: Library['mode'], name?: string) =>
    req<Library[]>('/api/libraries', json('POST', { path, mode, name })),
  updateLibrary: (id: number, patch: Partial<Pick<Library, 'name' | 'mode' | 'enabled'>>) =>
    req<Library[]>(`/api/libraries/${id}`, json('PATCH', patch)),
  deleteLibrary: (id: number) => req<Library[]>(`/api/libraries/${id}`, { method: 'DELETE' }),
  browse: (path?: string) => req<BrowseResult>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  mounts: () => req<MountedFolder[]>('/api/fs/mounts'),
  scanStatus: () => req<ScanStatus>('/api/library/status'),
  rescan: (force = false) => req<ScanStatus>(`/api/library/rescan?force=${force}`, { method: 'POST' }),
}
