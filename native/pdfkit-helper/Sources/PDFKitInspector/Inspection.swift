import Foundation
import PDFKit
import CoreGraphics


func inspectOptionalContent(_ document: PDFDocument, limits: Limits) -> OptionalContentInventory {
    guard let catalog = document.documentRef?.catalog else {
        return OptionalContentInventory(
            present: false, groupCount: 0, groups: [], groupsTruncated: false,
            defaultConfigurationPresent: false
        )
    }
    var properties: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "OCProperties", &properties), let properties else {
        return OptionalContentInventory(
            present: false, groupCount: 0, groups: [], groupsTruncated: false,
            defaultConfigurationPresent: false
        )
    }
    var defaultConfiguration: CGPDFDictionaryRef?
    let hasDefaultConfiguration = CGPDFDictionaryGetDictionary(properties, "D", &defaultConfiguration)
    var offArray: CGPDFArrayRef?
    let hasOffList = defaultConfiguration.flatMap { CGPDFDictionaryGetArray($0, "OFF", &offArray) } ?? false
    let offNames: Set<String> = hasOffList ? (0..<(CGPDFArrayGetCount(offArray!))).compactMap { index in
        var group: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(offArray!, index, &group), let group else { return nil }
        var raw: CGPDFStringRef?
        return CGPDFDictionaryGetString(group, "Name", &raw) ? raw.flatMap { CGPDFStringCopyTextString($0) as String? } : nil
    }.reduce(into: Set<String>()) { $0.insert($1) } : []
    var groupArray: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(properties, "OCGs", &groupArray), let groupArray else {
        return OptionalContentInventory(
            present: true, groupCount: 0, groups: [], groupsTruncated: false,
            defaultConfigurationPresent: hasDefaultConfiguration
        )
    }
    let groupCount = CGPDFArrayGetCount(groupArray)
    let inspectedCount = min(groupCount, limits.maxOutlineItems)
    let groups = (0..<inspectedCount).map { index -> OptionalContentGroup in
        var group: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(groupArray, index, &group), let group else {
            return OptionalContentGroup(index: index, name: nil, defaultVisible: hasDefaultConfiguration ? true : nil)
        }
        var rawName: CGPDFStringRef?
        let name = CGPDFDictionaryGetString(group, "Name", &rawName)
            ? rawName.flatMap { boundedString(CGPDFStringCopyTextString($0) as String?) }
            : nil
        return OptionalContentGroup(index: index, name: name, defaultVisible: hasDefaultConfiguration ? !(name.map(offNames.contains) ?? false) : nil)
    }
    return OptionalContentInventory(
        present: true, groupCount: groupCount, groups: groups,
        groupsTruncated: groupCount > groups.count,
        defaultConfigurationPresent: hasDefaultConfiguration
    )
}

func inspect(_ document: PDFDocument, limits: Limits, sourceData: Data) throws -> InspectionResult {
    let sourceDigest = sha256Hex(sourceData)
    let count = document.pageCount
    for index in 0..<min(count, limits.maxPages) {
        guard let page = document.page(at: index) else { continue }
        if let label = page.label, label.utf8.count > maximumStringLength {
            throw InspectionFailure.responseTooLarge
        }
    }
    let pages = (0..<min(count, limits.maxPages)).compactMap { index -> PageInventory? in
        guard let page = document.page(at: index) else { return nil }
        return inspectPage(page, index: index + 1, limits: limits, sourceDigest: sourceDigest, document: document)
    }
    return InspectionResult(
        document: DocumentInventory(
            pageCount: count, encrypted: document.isEncrypted, locked: document.isLocked,
            permissions: Permissions(
                copying: document.allowsCopying, printing: document.allowsPrinting,
                changes: document.allowsDocumentChanges, commenting: document.allowsCommenting,
                formFieldEntry: document.allowsFormFieldEntry,
                assembly: document.allowsDocumentAssembly,
                contentAccessibility: document.allowsContentAccessibility,
                status: permissionStatus(document.permissionsStatus)
            ),
            supportedAnnotationTypes: annotationTypes
        ),
        metadata: metadata(document), pages: pages, pagesTruncated: count > pages.count,
        outline: inspectOutline(document, limits: limits, sourceDigest: sourceDigest),
        pageLabels: inspectPageLabels(document, limits: limits),
        optionalContent: inspectOptionalContent(document, limits: limits)
    )
}

func permissionStatus(_ status: PDFDocumentPermissions) -> String {
    switch status {
    case .none: return "none"
    case .user: return "user"
    case .owner: return "owner"
    @unknown default: return "unknown"
    }
}
