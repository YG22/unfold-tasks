export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      notification_settings: {
        Row: {
          enabled: boolean
          remind_at_start: boolean
          remind_before: boolean
          reminders_from: string
          timezone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          enabled?: boolean
          remind_at_start?: boolean
          remind_before?: boolean
          reminders_from?: string
          timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          enabled?: boolean
          remind_at_start?: boolean
          remind_before?: boolean
          reminders_from?: string
          timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      planner_availability: {
        Row: {
          created_at: string
          deleted_at: string | null
          end_min: number
          ends_next_day: boolean
          id: string
          start_min: number
          updated_at: string
          user_id: string
          version: number
          weekday: number
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          end_min: number
          ends_next_day?: boolean
          id: string
          start_min: number
          updated_at?: string
          user_id?: string
          version?: number
          weekday: number
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          end_min?: number
          ends_next_day?: boolean
          id?: string
          start_min?: number
          updated_at?: string
          user_id?: string
          version?: number
          weekday?: number
        }
        Relationships: []
      }
      planner_categories: {
        Row: {
          color: string
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          color: string
          created_at?: string
          deleted_at?: string | null
          id: string
          name: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Update: {
          color?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      planner_events: {
        Row: {
          category_builtin: string | null
          category_id: string | null
          created_at: string
          date: string
          deleted_at: string | null
          duration_min: number
          id: string
          notes: string | null
          split_from_event_id: string | null
          start_min: number
          title: string
          travel_after_min: number
          travel_before_min: number
          until: string | null
          updated_at: string
          user_id: string
          version: number
          weekdays: number[] | null
        }
        Insert: {
          category_builtin?: string | null
          category_id?: string | null
          created_at?: string
          date: string
          deleted_at?: string | null
          duration_min: number
          id: string
          notes?: string | null
          split_from_event_id?: string | null
          start_min: number
          title: string
          travel_after_min?: number
          travel_before_min?: number
          until?: string | null
          updated_at?: string
          user_id?: string
          version?: number
          weekdays?: number[] | null
        }
        Update: {
          category_builtin?: string | null
          category_id?: string | null
          created_at?: string
          date?: string
          deleted_at?: string | null
          duration_min?: number
          id?: string
          notes?: string | null
          split_from_event_id?: string | null
          start_min?: number
          title?: string
          travel_after_min?: number
          travel_before_min?: number
          until?: string | null
          updated_at?: string
          user_id?: string
          version?: number
          weekdays?: number[] | null
        }
        Relationships: [
          {
            foreignKeyName: "planner_events_category_id_user_id_fkey"
            columns: ["category_id", "user_id"]
            isOneToOne: false
            referencedRelation: "planner_categories"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "planner_events_split_from_event_id_user_id_fkey"
            columns: ["split_from_event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "planner_events"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      planner_exceptions: {
        Row: {
          created_at: string
          deleted_at: string | null
          event_id: string
          id: string
          new_date: string | null
          new_duration_min: number | null
          new_start_min: number | null
          original_date: string
          superseded_at: string | null
          superseded_by_event_id: string | null
          type: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          event_id: string
          id: string
          new_date?: string | null
          new_duration_min?: number | null
          new_start_min?: number | null
          original_date: string
          superseded_at?: string | null
          superseded_by_event_id?: string | null
          type: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          event_id?: string
          id?: string
          new_date?: string | null
          new_duration_min?: number | null
          new_start_min?: number | null
          original_date?: string
          superseded_at?: string | null
          superseded_by_event_id?: string | null
          type?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "planner_exceptions_event_id_user_id_fkey"
            columns: ["event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "planner_events"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "planner_exceptions_superseded_by_event_id_user_id_fkey"
            columns: ["superseded_by_event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "planner_events"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      planner_operations: {
        Row: {
          created_at: string
          kind: string
          op_id: string
          result: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          kind: string
          op_id: string
          result: Json
          user_id: string
        }
        Update: {
          created_at?: string
          kind?: string
          op_id?: string
          result?: Json
          user_id?: string
        }
        Relationships: []
      }
      planner_settings: {
        Row: {
          created_at: string
          default_view: string
          suggestion_days_off: number[]
          timezone: string | null
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          default_view?: string
          suggestion_days_off?: number[]
          timezone?: string | null
          updated_at?: string
          user_id?: string
          version?: number
        }
        Update: {
          created_at?: string
          default_view?: string
          suggestion_days_off?: number[]
          timezone?: string | null
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          failure_count: number
          id: string
          last_success_at: string | null
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          failure_count?: number
          id?: string
          last_success_at?: string | null
          p256dh: string
          user_agent?: string | null
          user_id?: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          failure_count?: number
          id?: string
          last_success_at?: string | null
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      reminder_deliveries: {
        Row: {
          accepted_count: number
          attempts: number
          created_at: string
          failed_count: number
          fire_at: string
          id: string
          kind: string
          next_attempt_at: string | null
          status: string
          subtask_id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_count?: number
          attempts?: number
          created_at?: string
          failed_count?: number
          fire_at: string
          id?: string
          kind: string
          next_attempt_at?: string | null
          status?: string
          subtask_id: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_count?: number
          attempts?: number
          created_at?: string
          failed_count?: number
          fire_at?: string
          id?: string
          kind?: string
          next_attempt_at?: string | null
          status?: string
          subtask_id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      subtasks: {
        Row: {
          created_at: string
          done: boolean
          due_date: string | null
          duration_min: number | null
          id: string
          list_id: string
          position: number
          start_date: string | null
          start_time: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          done?: boolean
          due_date?: string | null
          duration_min?: number | null
          id?: string
          list_id: string
          position?: number
          start_date?: string | null
          start_time?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          done?: boolean
          due_date?: string | null
          duration_min?: number | null
          id?: string
          list_id?: string
          position?: number
          start_date?: string | null
          start_time?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subtasks_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "task_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      task_groups: {
        Row: {
          created_at: string
          id: string
          position: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          position?: number
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          position?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      task_lists: {
        Row: {
          created_at: string
          group_id: string | null
          id: string
          position: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          group_id?: string | null
          id?: string
          position?: number
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          group_id?: string | null
          id?: string
          position?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_lists_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "task_groups"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _planner_cols: { Args: { full_: boolean; t: string }; Returns: string[] }
      _planner_content: {
        Args: { cols: string[]; j: Json; t: string }
        Returns: Json
      }
      _planner_defaults: { Args: { t: string }; Returns: Json }
      _planner_get: {
        Args: { rid: string; t: string; uid: string }
        Returns: Json
      }
      _planner_insert: {
        Args: {
          cols: string[]
          content: Json
          rid: string
          t: string
          uid: string
        }
        Returns: number
      }
      _planner_record: { Args: { a: Json; uid: string }; Returns: Json }
      _planner_restore: {
        Args: { apply_: boolean; p: Json; uid: string }
        Returns: Json
      }
      _planner_settings: { Args: { a: Json; uid: string }; Returns: Json }
      _planner_split: { Args: { a: Json; uid: string }; Returns: Json }
      _planner_status: {
        Args: { cur: Json; rid: string; s: string }
        Returns: Json
      }
      _planner_table: { Args: { t: string }; Returns: string }
      _planner_update: {
        Args: {
          cols: string[]
          content: Json
          del: string
          rid: string
          t: string
          uid: string
        }
        Returns: undefined
      }
      apply_planner_changes: { Args: { p: Json }; Returns: Json }
      apply_task_changes: { Args: { p: Json }; Returns: undefined }
      claim_due_reminders: {
        Args: { p_grace?: string; p_now?: string }
        Returns: {
          attempts: number
          fire_at: string
          id: string
          kind: string
          subtask_id: string
          title: string
          user_id: string
        }[]
      }
      planner_days_ok: { Args: { a: number[] }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
