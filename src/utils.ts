import { TagType, TagData, ListPayload } from 'mc-anvil';

export const toArrayBuffer = (buffer: Buffer): ArrayBuffer => {
	const arrayBuffer = new ArrayBuffer(buffer.length);
	const view = new Uint8Array(arrayBuffer);
	for (let i = 0; i < buffer.length; ++i) {
		view[i] = buffer[i];
	}
	return arrayBuffer;
};

export const isCompound = (t: TagData): t is TagData & { data: TagData[] } => {
	return t.type === TagType.COMPOUND;
};

export const isCompoundList = (t: TagData): t is TagData & { data: ListPayload } => {
	return t.type === TagType.LIST && (t.data as ListPayload)?.subType === TagType.COMPOUND;
};

export const isList = (t: TagData): t is TagData & { data: ListPayload } => {
    return t.type === TagType.LIST && typeof (t.data as ListPayload)?.subType === 'number' && Array.isArray((t.data as ListPayload).data);
};

export const getPrinteableValue = (tag: TagData): string => {
	if (isCompound(tag)) {
		return `Compound with ${tag.data.length} children`;
	}
	else if (isCompoundList(tag)) {
		return `List of	Compounds with ${tag.data.data.length} items`;
	}
	else if (isList(tag)) {
		return `List of ${TagType[tag.data.subType]} with ${tag.data.data.length} items: ${tag.data.data.map(item => getPrinteableValue({ type: tag.data.subType, name: '', data: item })).join(', ')}`;
	}
	else {
		return String(tag.data);
	}
};

export const walk = (tag: TagData, prefix = ''): void => {
	if (tag.type === TagType.END) return;
	const path = prefix ? `${prefix}/${tag.name}` : tag.name;
	console.debug(`${path || '(root)'}  [${TagType[tag.type]}]: ${getPrinteableValue(tag)}`);

	if (isCompound(tag)) {
		tag.data.forEach(c => walk(c, path));
	}
	else if (isCompoundList(tag)) {
		tag.data.data.forEach((item, i) =>
		walk({ type: TagType.COMPOUND, name: `[${i}]`, data: item as TagData[] }, path));
	}
}
