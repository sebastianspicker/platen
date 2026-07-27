struct LocalGoToSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
}

struct LineAnnotationSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
}

struct InkAnnotationSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
}

struct PageRotationSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
}

struct PageBoxMutationSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
    let annotationDescriptors: [[CropAnnotationDescriptor]]
}
