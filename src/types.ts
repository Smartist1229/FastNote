export interface Note {
  id: number;
  title: string;
  content: string;
  category_id: number | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
}

export interface Category {
  id: number;
  name: string;
  created_at: string;
  note_count: number;
}
