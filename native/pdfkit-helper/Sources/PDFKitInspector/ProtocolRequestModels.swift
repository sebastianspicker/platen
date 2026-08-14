import Foundation
struct MutationRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let mutation: Mutation
}
struct TargetedMutationRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let mutation: TargetedMutation
}
struct LocalGoToRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let link: LocalGoToLink
}
struct OutlineBookmarkRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let bookmark: OutlineBookmark
}
struct OutlineBookmark: Decodable {
    let page: Int
    let label: String
}
struct OutlineBookmarkRemovalRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let bookmark: OutlineBookmarkRemovalTarget
}
struct OutlineBookmarkRemovalTarget: Decodable {
    let topLevelIndex: Int
    let fingerprint: String
}
struct OutlineBookmarkRenameRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let bookmarkRename: OutlineBookmarkRenameTarget
}
struct OutlineBookmarkRenameTarget: Decodable {
    let topLevelIndex: Int
    let fingerprint: String
    let label: String
}
struct LocalGoToLink: Decodable {
    let sourcePage: Int
    let targetPage: Int
    let rect: MutationRectangle
}
struct LocalGoToRemovalRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let link: LocalGoToRemovalTarget
}
struct LocalGoToRemovalTarget: Decodable {
    let page: Int
    let annotationIndex: Int
    let fingerprint: String
}
struct LineAnnotationRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let line: LineAnnotationEdit
}

struct LineAnnotationEdit: Decodable {
    let page: Int
    let contents: String
    let start: LineAnnotationPoint
    let end: LineAnnotationPoint
}

struct LineAnnotationPoint: Decodable {
    let x: Double
    let y: Double
}

struct InkAnnotationRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let ink: InkAnnotationEdit
}

struct InkAnnotationEdit: Decodable {
    let page: Int
    let contents: String
    let points: [InkAnnotationPoint]
}

struct InkAnnotationPoint: Decodable {
    let x: Double
    let y: Double
}

struct TextFieldWidgetRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let field: TextFieldWidgetEdit
}

struct TextFieldWidgetEdit: Decodable {
    let page: Int
    let rect: MutationRectangle
    let name: String
    let defaultValue: String?
}

struct ProtectionRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let protection: Protection
}

struct ProtectionRemovalRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let removal: ProtectionRemoval
}

struct ProtectionRemoval: Decodable {
    let sourceProfile: String
    let ownerPassword: String
}

struct MetadataSanitizationRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
}

struct AecMeasurementRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let outputFilename: String
    let sourceSha256: String
    let limits: Limits
    let measurement: AecMeasurement
}

struct AecMeasurement: Decodable {
    let id: String
    let page: Int
    let kind: String
    let points: [MeasurementPoint]
    let quantity: Double
    let unit: String
    let calibrationId: String?
    let label: String
    let calibration: MeasurementCalibration?
}

struct MeasurementPoint: Decodable {
    let x: Double
    let y: Double
}

struct MeasurementCalibration: Decodable {
    let points: [MeasurementPoint]
    let realLength: Double
    let sourceUnit: String
    let metersPerPoint: Double
}

struct Protection: Decodable {
    let profile: String
    let ownerPassword: String
    let userPassword: String
}

struct TargetedMutation: Decodable {
    let formFill: FormFillEdit?
    let annotationUpdate: AnnotationUpdateEdit?
    let annotationRemove: AnnotationRemoveEdit?
    let annotationProperties: AnnotationPropertiesEdit?
}

struct FormFillEdit: Decodable {
    let page: Int
    let annotationIndex: Int
    let fingerprint: String
    let fieldType: String
    let value: String
}

struct AnnotationUpdateEdit: Decodable {
    let page: Int
    let annotationIndex: Int
    let fingerprint: String
    let subtype: String
    let contents: String
    let rect: MutationRectangle
}

struct AnnotationRemoveEdit: Decodable {
    let page: Int
    let annotationIndex: Int
    let fingerprint: String
    let subtype: String
}

struct AnnotationPropertiesEdit: Decodable {
    let page: Int
    let annotationIndex: Int
    let fingerprint: String
    let subtype: String
    let rect: MutationRectangle
    let strokeColor: String
}

struct Mutation: Decodable {
    let metadata: MetadataPatch?
    let pageBox: PageBoxEdit?
    let annotations: [AnnotationEdit]
    let rotation: PageRotationEdit?
}

struct MetadataPatch: Decodable {
    let title: String?
    let author: String?
    let subject: String?
    let keywords: String?
}

struct PageBoxEdit: Decodable {
    let page: Int
    let box: String
    let rect: MutationRectangle
}

struct PageRotationEdit: Decodable {
    let page: Int
    let degrees: Int
}

struct AnnotationEdit: Decodable {
    let page: Int
    let subtype: String
    let contents: String
    let rect: MutationRectangle
}

struct MutationRectangle: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}
