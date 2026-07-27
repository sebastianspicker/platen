import PDFKit
import CoreGraphics

func annotationHasActionOrAdditionalActions(_ annotation: PDFAnnotation) -> Bool {
    annotation.action != nil
        || annotation.value(forAnnotationKey: .action) != nil
        || annotation.value(forAnnotationKey: .additionalActions) != nil
}

func documentHasActionsOrSignatureWidgets(_ document: PDFDocument) -> Bool {
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return true }
        for annotation in page.annotations {
            if annotationHasActionOrAdditionalActions(annotation) { return true }
            if annotationSubtype(annotation) == "widget"
                && widgetType(annotation.value(forAnnotationKey: .widgetFieldType)) == "signature" {
                return true
            }
        }
    }
    return false
}

func rawPagesContainActions(_ document: PDFDocument) -> Bool {
    guard document.pageCount >= 1, let documentRef = document.documentRef else { return true }
    for pageNumber in 1...document.pageCount {
        guard let pageDictionary = documentRef.page(at: pageNumber)?.dictionary else { return true }
        if dictionaryContainsObject(pageDictionary, key: "AA") { return true }
        var annotations: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations) else { continue }
        guard let annotations else { return true }
        for annotationIndex in 0..<CGPDFArrayGetCount(annotations) {
            var annotation: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(annotations, annotationIndex, &annotation), let annotation else { return true }
            if dictionaryContainsObject(annotation, key: "A") || dictionaryContainsObject(annotation, key: "AA") {
                return true
            }
        }
    }
    return false
}

func documentHasWidgets(_ document: PDFDocument) -> Bool {
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return true }
        if page.annotations.contains(where: { annotationSubtype($0) == "widget" }) { return true }
    }
    return false
}

func outlineContainsActions(_ catalog: CGPDFDictionaryRef) -> Bool {
    guard dictionaryContainsObject(catalog, key: "Outlines") else { return false }
    var root: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &root), let root else { return true }
    if dictionaryContainsObject(root, key: "A") || dictionaryContainsObject(root, key: "AA") { return true }
    guard dictionaryContainsObject(root, key: "First") else { return false }
    var first: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(root, "First", &first), let first else { return true }
    var remaining = maximumOutlineItems
    func visitSiblings(_ initial: CGPDFDictionaryRef) -> Bool {
        var current: CGPDFDictionaryRef? = initial
        while let item = current {
            guard remaining > 0 else { return true }
            remaining -= 1
            if dictionaryContainsObject(item, key: "A") || dictionaryContainsObject(item, key: "AA") { return true }
            if dictionaryContainsObject(item, key: "First") {
                var child: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(item, "First", &child), let child else { return true }
                if visitSiblings(child) { return true }
            }
            guard dictionaryContainsObject(item, key: "Next") else { current = nil; continue }
            var next: CGPDFDictionaryRef?
            guard CGPDFDictionaryGetDictionary(item, "Next", &next), let next else { return true }
            current = next
        }
        return false
    }
    return visitSiblings(first)
}

func catalogContainsUnsafeTargetedFormContent(_ document: PDFDocument) -> Bool {
    guard let catalog = document.documentRef?.catalog else { return true }
    if ["OpenAction", "AA", "AF", "Perms"].contains(where: { dictionaryContainsObject(catalog, key: $0) }) {
        return true
    }
    if outlineContainsActions(catalog) { return true }
    var names: CGPDFDictionaryRef?
    if dictionaryContainsObject(catalog, key: "Names") {
        guard CGPDFDictionaryGetDictionary(catalog, "Names", &names), let names,
              dictionaryContainsOnlyKeys(names, allowed: ["Dests"])
        else { return true }
    }
    var acroForm: CGPDFDictionaryRef?
    guard dictionaryContainsObject(catalog, key: "AcroForm") else { return false }
    guard CGPDFDictionaryGetDictionary(catalog, "AcroForm", &acroForm), let acroForm else { return true }
    if ["XFA", "AA", "CO"].contains(where: { dictionaryContainsObject(acroForm, key: $0) }) { return true }
    return acroFormContainsUnsafeFields(acroForm)
}

func targetedDocumentContainsUnsafeContent(_ document: PDFDocument) -> Bool {
    documentHasActionsOrSignatureWidgets(document) || rawPagesContainActions(document)
        || catalogContainsUnsafeTargetedFormContent(document)
}

func acroFormContainsUnsafeFields(_ acroForm: CGPDFDictionaryRef) -> Bool {
    var fields: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(acroForm, "Fields", &fields), let fields else { return true }
    var remaining = maximumPages * maximumAnnotationsPerPage
    func visit(_ field: CGPDFDictionaryRef, inheritedType: String?) -> Bool {
        guard remaining > 0 else { return true }
        remaining -= 1
        let fieldType = pdfName(field, key: "FT") ?? inheritedType
        if fieldType == "Sig" || dictionaryContainsObject(field, key: "A") || dictionaryContainsObject(field, key: "AA") { return true }
        var children: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(field, "Kids", &children), let children else { return false }
        let count = CGPDFArrayGetCount(children)
        guard count <= remaining else { return true }
        for index in 0..<count {
            var child: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(children, index, &child), let child else { return true }
            if visit(child, inheritedType: fieldType) { return true }
        }
        return false
    }
    let count = CGPDFArrayGetCount(fields)
    guard count <= remaining else { return true }
    for index in 0..<count {
        var field: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(fields, index, &field), let field else { return true }
        if visit(field, inheritedType: nil) { return true }
    }
    return false
}

func catalogContainsProhibitedProtectionContent(_ document: PDFDocument) -> Bool {
    guard let catalog = document.documentRef?.catalog else { return true }
    if dictionaryContainsObject(catalog, key: "AcroForm")
        || dictionaryContainsObject(catalog, key: "OpenAction")
        || dictionaryContainsObject(catalog, key: "AA")
        || dictionaryContainsObject(catalog, key: "AF") {
        return true
    }
    var markInfo: CGPDFDictionaryRef?
    if CGPDFDictionaryGetDictionary(catalog, "MarkInfo", &markInfo), let markInfo {
        var marked = false
        if CGPDFDictionaryGetBoolean(markInfo, "Marked", &marked), marked { return true }
    }
    var names: CGPDFDictionaryRef?
    if CGPDFDictionaryGetDictionary(catalog, "Names", &names), let names,
       dictionaryContainsObject(names, key: "JavaScript") || dictionaryContainsObject(names, key: "EmbeddedFiles") {
        return true
    }
    return false
}

func catalogContainsAecUnsupportedContent(_ document: PDFDocument) -> Bool {
    guard let catalog = document.documentRef?.catalog else { return true }
    if ["AcroForm", "OpenAction", "AA", "AF", "Perms"].contains(where: { dictionaryContainsObject(catalog, key: $0) }) {
        return true
    }
    var names: CGPDFDictionaryRef?
    if CGPDFDictionaryGetDictionary(catalog, "Names", &names), let names,
       dictionaryContainsObject(names, key: "JavaScript") || dictionaryContainsObject(names, key: "EmbeddedFiles") {
        return true
    }
    return false
}

func protectionStructure(_ document: PDFDocument, limits: Limits) -> ProtectionStructureSummary? {
    guard isWithin(document.pageCount, 1, limits.maxPages) else { return nil }
    var rotations: [Int] = []
    var annotationCounts: [Int] = []
    var annotationSubtypes: [[String]] = []
    rotations.reserveCapacity(document.pageCount)
    annotationCounts.reserveCapacity(document.pageCount)
    annotationSubtypes.reserveCapacity(document.pageCount)
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex), page.annotations.count <= limits.maxAnnotationsPerPage else { return nil }
        rotations.append(page.rotation)
        annotationCounts.append(page.annotations.count)
        annotationSubtypes.append(page.annotations.map(annotationSubtype))
    }
    return ProtectionStructureSummary(
        pageRotations: rotations, annotationCounts: annotationCounts, annotationSubtypes: annotationSubtypes
    )
}
