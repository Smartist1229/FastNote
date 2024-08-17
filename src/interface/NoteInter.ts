interface Note {
    id: string,
    title: string,
    date: string,
    content: string,
    classId: string
    isEdit?: boolean,
    isActive?: boolean
}

export type noteInter = Note;