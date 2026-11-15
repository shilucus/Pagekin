/** Explicit retained-view admission; it grants no background execution authority. */
export const PROJECT_RUNTIME_OPEN_VIEW_CHANNEL = 'project-runtime:v1:open-view' as const

/** Author view switching retains admitted work and releases only safely retired managed views. */
export const PROJECT_RUNTIME_OPEN_BACKGROUND_VIEW_CHANNEL = 'project-runtime:v1:open-background-view' as const
