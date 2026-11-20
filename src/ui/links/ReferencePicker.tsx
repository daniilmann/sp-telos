export interface ReferenceOption {
  readonly title: string;
  readonly isArchived?: boolean;
}

export type ReferenceOptions = Readonly<Record<string, ReferenceOption>>;

interface PickerProps {
  readonly label: string;
  readonly options: ReferenceOptions;
  readonly value: string;
  readonly placeholder?: string;
  readonly change: (key: string) => void;
  readonly disabled?: boolean;
}

export function ReferencePicker({
  label,
  options,
  value,
  placeholder = 'Выберите значение',
  change,
  disabled,
}: Readonly<PickerProps>) {
  return (
    <div class="field">
      <label htmlFor={label}>{label}</label>
      <select
        id={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          change(event.currentTarget.value);
        }}
      >
        <option value="">{placeholder}</option>
        {value && !options[value] && <option value={value}>Недоступно</option>}
        <ReferenceChoices options={options} />
      </select>
    </div>
  );
}

export function ReferenceChoices({ options }: { readonly options: ReferenceOptions }) {
  return Object.entries(options).map(([key, reference]) => (
    <option key={key} value={key}>
      {reference.title}
    </option>
  ));
}

export function MultipleReferences({
  label,
  options,
  values,
  change,
}: {
  readonly label: string;
  readonly options: ReferenceOptions;
  readonly values: readonly string[];
  readonly change: (keys: readonly string[]) => void;
}) {
  const missing = values.filter((key) => !options[key]);
  return (
    <div class="field">
      <label htmlFor="direct-kr-keys">{label}</label>
      <select
        id="direct-kr-keys"
        multiple
        onChange={(event) => {
          const chosen = Array.from(event.currentTarget.selectedOptions, (option) => option.value);
          const next = [...missing, ...chosen.filter((key) => options[key])];
          if (next.length !== values.length || next.some((key) => !values.includes(key)))
            change(next);
        }}
      >
        {missing.map((key) => (
          <option key={key} value={key} selected disabled>
            Недоступно
          </option>
        ))}
        {Object.entries(options).map(([key, reference]) => (
          <option key={key} value={key} selected={values.includes(key)}>
            {reference.title}
          </option>
        ))}
      </select>
      {missing.map((key) => (
        <button
          type="button"
          key={key}
          onClick={() => {
            change(values.filter((item) => item !== key));
          }}
        >
          Снять недоступный KR ({key})
        </button>
      ))}
    </div>
  );
}
