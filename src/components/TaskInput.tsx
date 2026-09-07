import { useState } from "react";
import plusIcon from "@/assets/plus-icon.png.asset.json";
import emojiIcon from "@/assets/emoji.png.asset.json";

type Props = {
  placeholder: string;
  onAdd: (title: string) => void;
};

export function TaskInput({ placeholder, onAdd }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(true);
      return;
    }
    onAdd(trimmed);
    setValue("");
    setError(false);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={error ? "לא ניתן להכניס משימה ללא תווים" : placeholder}
          className={`w-full rounded-2xl bg-card px-5 py-4 text-base shadow-[var(--shadow-soft)] outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring ${
            error ? "text-destructive placeholder:text-destructive" : "text-foreground"
          }`}
        />
      </div>
      <button
        type="button"
        onClick={submit}
        aria-label="הוספה"
        className="shrink-0 transition-transform hover:scale-105 active:scale-95"
      >
        <img
          src={error ? emojiIcon.url : plusIcon.url}
          alt={error ? "שגיאה" : "הוספה"}
          className="h-14 w-14"
        />
      </button>
    </div>
  );
}
