import type { NativeKit } from '../core/NativeKit';

export interface PickedContact {
  picked: boolean;
  name?: string;
  phones?: string[];
  emails?: string[];
}

export interface Contact {
  name?: string;
  phones?: string[];
  emails?: string[];
}

/** Contact picker — native: CNContactPicker (no permission needed); web: Contact Picker API where present. */
export class ContactsModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('contacts');
  }

  /** Open the system contact picker; resolves { picked: false } when dismissed. */
  pick(): Promise<PickedContact> {
    return this.kit.invoke('contacts.pick', undefined, { timeoutMs: 120_000 });
  }

  /** Read the full address book; native-only (requires permission), unsupported on web. */
  getAll(): Promise<{ contacts: Contact[] }> {
    return this.kit.invoke('contacts.getAll', undefined, { timeoutMs: 120_000 });
  }
}
