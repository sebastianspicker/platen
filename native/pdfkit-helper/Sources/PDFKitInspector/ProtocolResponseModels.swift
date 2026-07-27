import Foundation


struct ErrorResponse: Encodable {
    let version = protocolVersion
    let ok = false
    let error: ErrorBody
}

struct ErrorBody: Encodable {
    let code: String
}

struct SuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: InspectionResult
}

struct MutationSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: MutationResult
}

struct StandardMutationSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: StandardMutationReceipt
}

struct LocalGoToSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: LocalGoToReceipt
}

struct LocalGoToRemovalSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: LocalGoToRemovalReceipt
}

struct OutlineBookmarkSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: OutlineBookmarkReceipt
}

struct OutlineBookmarkRemovalSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: OutlineBookmarkRemovalReceipt
}

struct OutlineBookmarkRenameSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: OutlineBookmarkRenameReceipt
}

struct LineAnnotationSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: LineAnnotationReceipt
}

struct InkAnnotationSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: InkAnnotationReceipt
}

struct TextFieldWidgetSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: TextFieldWidgetReceipt
}

struct ProtectionSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: ProtectionReceipt
}

struct ProtectionRemovalSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: ProtectionRemovalReceipt
}

struct MetadataSanitizationSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: MetadataSanitizationReceipt
}

struct MutationResult: Encodable {
    let appliedEdits: Int
    let inspection: InspectionResult
}

struct StandardMutationReceipt: Encodable {
    let schema = "pdfkit-mutation-receipt-v1"
    let version = protocolVersion
    let operation = "mutate"
    let category = "structure-mutation"
    let sourceSha256: String
    let outputSha256: String
    let appliedEdits: Int
    let inspection: InspectionResult
}

struct LocalGoToReceipt: Encodable {
    let schema = "pdfkit-local-goto-receipt-v1"
    let version = protocolVersion
    let operation = "addLocalGoToLink"
    let category = "local-goto-link"
    let sourceSha256: String
    let outputSha256: String
    let sourcePage: Int
    let targetPage: Int
    let annotationIndex: Int
    let pageCount: Int
    let appliedEdits = 1
    let rawDestinationVerified = true
    let localGoToActionVerified = true
    let reopenVerified = true
}

struct LocalGoToRemovalReceipt: Encodable {
    let schema = "pdfkit-local-goto-removal-receipt-v1"
    let version = protocolVersion
    let operation = "removeLocalGoToLink"
    let category = "local-goto-link-removal"
    let sourceSha256: String
    let outputSha256: String
    let page: Int
    let annotationIndex: Int
    let pageCount: Int
    let appliedEdits = 1
    let rawTargetVerified = true
    let annotationRemoved = true
    let pageGeometryVerified = true
    let annotationInventoryVerified = true
    let reopenVerified = true
}

struct OutlineBookmarkReceipt: Encodable {
    let schema = "pdfkit-outline-bookmark-receipt-v1"
    let version = protocolVersion
    let operation = "appendOutlineBookmark"
    let category = "outline-bookmark"
    let sourceSha256: String
    let outputSha256: String
    let labelSha256: String
    let page: Int
    let pageCount: Int
    let appliedEdits = 1
    let outlineAppended = true
    let priorOutlineTreeVerified = true
    let pageGeometryVerified = true
    let annotationInventoryVerified = true
    let rawDestinationVerified = true
    let destinationVerified = true
    let reopenVerified = true
}

struct OutlineBookmarkRemovalReceipt: Encodable {
    let schema = "pdfkit-outline-removal-receipt-v1"
    let version = protocolVersion
    let operation = "removeOutlineBookmark"
    let category = "outline-bookmark-removal"
    let sourceSha256: String
    let outputSha256: String
    let topLevelIndex: Int
    let pageCount: Int
    let appliedEdits = 1
    let rawTargetVerified = true
    let outlineRemoved = true
    let remainingOutlineTreeVerified = true
    let pageGeometryVerified = true
    let annotationInventoryVerified = true
    let contentSnapshotVerified = true
    let reopenVerified = true
}

struct OutlineBookmarkRenameReceipt: Encodable {
    let schema = "pdfkit-outline-rename-receipt-v1"
    let version = protocolVersion
    let operation = "renameOutlineBookmark"
    let category = "outline-bookmark-rename"
    let sourceSha256: String
    let outputSha256: String
    let topLevelIndex: Int
    let labelSha256: String
    let pageCount: Int
    let appliedEdits = 1
    let rawTargetVerified = true
    let outlineRenamed = true
    let remainingOutlineTreeVerified = true
    let pageGeometryVerified = true
    let annotationInventoryVerified = true
    let contentSnapshotVerified = true
    let reopenVerified = true
}

struct LineAnnotationReceipt: Encodable {
    let schema = "pdfkit-line-receipt-v1"
    let version = protocolVersion
    let operation = "addLineAnnotation"
    let category = "line-annotation"
    let sourceSha256: String
    let outputSha256: String
    let page: Int
    let annotationIndex: Int
    let pageCount: Int
    let appliedEdits = 1
    let geometryVerified = true
    let lineStylesVerified = true
    let reopenVerified = true
}

struct InkAnnotationReceipt: Encodable {
    let schema = "pdfkit-ink-receipt-v1"
    let version = protocolVersion
    let operation = "addInkAnnotation"
    let category = "ink-annotation"
    let sourceSha256: String
    let outputSha256: String
    let page: Int
    let annotationIndex: Int
    let pageCount: Int
    let appliedEdits = 1
    let geometryVerified = true
    let rawInkListVerified = true
    let reopenVerified = true
}

struct TextFieldWidgetReceipt: Encodable {
    let schema = "pdfkit-text-field-widget-receipt-v1"
    let version = protocolVersion
    let operation = "addTextFieldWidget"
    let category = "acroform-text-field-widget"
    let sourceSha256: String
    let outputSha256: String
    let fieldNameSha256: String
    let defaultValueSha256: String
    let rectSha256: String
    let page: Int
    let pageCount: Int
    let appliedEdits = 1
    let directAcroFormTopologyVerified = true
    let terminalTextWidgetVerified = true
    let sourceSafetyVerified = true
    let preservationVerified = true
    let reopenVerified = true
}

struct ProtectionReceipt: Encodable {
    let schema = "pdfkit-protection-receipt-v1"
    let version = protocolVersion
    let operation = "protect"
    let sourceSha256: String
    let outputSha256: String
    let profile: String
    let effectivePermissions: [String]
    let effectivePermissionMask: Int
    let pageCount: Int
    let structuralSummary: ProtectionStructureSummary
}

struct ProtectionRemovalReceipt: Encodable {
    let schema = "pdfkit-deprotection-receipt-v1"
    let version = protocolVersion
    let operation = "removeProtection"
    let sourceSha256: String
    let outputSha256: String
    let sourceProfile: String
    let pageCount: Int
    let structuralSummary: ProtectionStructureSummary
    let ownerAuthorizationVerified = true
    let encryptionRemoved = true
    let reopenVerified = true
}

struct MetadataSanitizationReceipt: Encodable {
    let schema = "pdfkit-metadata-sanitization-receipt-v1"
    let version = protocolVersion
    let operation = "sanitizeMetadata"
    let sourceSha256: String
    let outputSha256: String
    let pageCount: Int
    let observedCategories: [String]
    let freshDocumentCopy = true
    let metadataAbsent = true
    let contentSnapshotMatched = true
    let reopenVerified = true
}

struct AecMeasurementSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: AecMeasurementReceipt
}

struct AecMeasurementReceipt: Encodable {
    let schema = "pdfkit-aec-measurement-receipt-v1"
    let version = protocolVersion
    let operation = "applyAecMeasurement"
    let sourceSha256: String
    let outputSha256: String
    let measurementId: String
    let page: Int
    let kind: String
    let quantity: Double
    let unit: String
    let calibrationId: String?
    let annotationCount: Int
    let annotationSubtypes: [String]
    let measurementDictionaryEmbedded = false
    let pageCount: Int

    private enum CodingKeys: String, CodingKey {
        case schema, version, operation, sourceSha256, outputSha256, measurementId, page, kind, quantity, unit
        case calibrationId, annotationCount, annotationSubtypes, measurementDictionaryEmbedded, pageCount
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(version, forKey: .version)
        try container.encode(operation, forKey: .operation)
        try container.encode(sourceSha256, forKey: .sourceSha256)
        try container.encode(outputSha256, forKey: .outputSha256)
        try container.encode(measurementId, forKey: .measurementId)
        try container.encode(page, forKey: .page)
        try container.encode(kind, forKey: .kind)
        try container.encode(quantity, forKey: .quantity)
        try container.encode(unit, forKey: .unit)
        if let calibrationId { try container.encode(calibrationId, forKey: .calibrationId) }
        else { try container.encodeNil(forKey: .calibrationId) }
        try container.encode(annotationCount, forKey: .annotationCount)
        try container.encode(annotationSubtypes, forKey: .annotationSubtypes)
        try container.encode(measurementDictionaryEmbedded, forKey: .measurementDictionaryEmbedded)
        try container.encode(pageCount, forKey: .pageCount)
    }
}
