import Foundation
import PDFKit
import CoreGraphics


func metadata(_ document: PDFDocument) -> MetadataInventory {
    let attributes = document.documentAttributes ?? [:]
    func string(_ key: PDFDocumentAttribute) -> String? { boundedString(attributes[key] as? String) }
    func date(_ key: PDFDocumentAttribute) -> String? {
        guard let value = attributes[key] as? Date else { return nil }
        return ISO8601DateFormatter().string(from: value)
    }
    func keywords() -> String? {
        if let value = attributes[PDFDocumentAttribute.keywordsAttribute] as? String { return boundedString(value) }
        if let values = attributes[PDFDocumentAttribute.keywordsAttribute] as? [String] {
            return boundedString(values.prefix(64).joined(separator: ", "))
        }
        return nil
    }
    return MetadataInventory(
        title: string(.titleAttribute), author: string(.authorAttribute), subject: string(.subjectAttribute),
        creator: string(.creatorAttribute), producer: string(.producerAttribute),
        creationDate: date(.creationDateAttribute), modificationDate: date(.modificationDateAttribute),
        keywords: keywords()
    )
}

func destinationPage(_ destination: PDFDestination, in document: PDFDocument) -> Int? {
    guard let page = destination.page else { return nil }
    let index = document.index(for: page)
    guard index != NSNotFound, index >= 0, index < document.pageCount else { return nil }
    return index + 1
}

func namedAction(_ action: PDFActionNamed) -> String {
    switch action.name.rawValue {
    case 1: return "nextPage"
    case 2: return "previousPage"
    case 3: return "firstPage"
    case 4: return "lastPage"
    case 5: return "goBack"
    case 6: return "goForward"
    case 7: return "goToPage"
    case 8: return "find"
    case 9: return "print"
    case 10: return "zoomIn"
    case 11: return "zoomOut"
    default: return "none"
    }
}

func inspectLink(
    _ annotation: PDFAnnotation,
    annotationIndex: Int,
    document: PDFDocument
) -> LinkInventory {
    if let action = annotation.action as? PDFActionGoTo {
        return LinkInventory(
            annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "goTo",
            targetPage: destinationPage(action.destination, in: document), target: nil, remotePage: nil
        )
    }
    if let destination = annotation.value(forAnnotationKey: .destination) as? PDFDestination {
        return LinkInventory(
            annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "goTo",
            targetPage: destinationPage(destination, in: document), target: nil, remotePage: nil
        )
    }
    if let action = annotation.action as? PDFActionURL {
        return LinkInventory(
            annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "url",
            targetPage: nil, target: boundedString(action.url?.absoluteString), remotePage: nil
        )
    }
    if let action = annotation.action as? PDFActionRemoteGoTo {
        let remotePage = action.pageIndex < 1_000_000 ? Int(action.pageIndex) + 1 : nil
        return LinkInventory(
            annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "remoteGoTo",
            targetPage: nil, target: boundedString(action.url.absoluteString), remotePage: remotePage
        )
    }
    if let action = annotation.action as? PDFActionNamed {
        return LinkInventory(
            annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "namedAction",
            targetPage: nil, target: namedAction(action), remotePage: nil
        )
    }
    let rawDestination = annotation.value(forAnnotationKey: .destination)
    if let value = rawDestination as? String {
        return LinkInventory(
            annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "namedDestination",
            targetPage: nil, target: boundedString(value), remotePage: nil
        )
    }
    return LinkInventory(
        annotationIndex: annotationIndex, rect: rectangle(annotation.bounds), kind: "unresolved",
        targetPage: nil, target: nil, remotePage: nil
    )
}

func inspectPage(
    _ page: PDFPage,
    index: Int,
    limits: Limits,
    sourceDigest: String,
    document: PDFDocument
) -> PageInventory {
    let allAnnotations: [PDFAnnotation] = page.annotations
    let annotations = allAnnotations.enumerated().prefix(limits.maxAnnotationsPerPage).map { annotationIndex, annotation in
        let subtype = annotationSubtype(annotation)
        let type = subtype == "widget" ? widgetType(annotation.value(forAnnotationKey: .widgetFieldType)) : nil
        return AnnotationInventory(
            subtype: subtype,
            annotationIndex: annotationIndex,
            fingerprint: annotationFingerprint(
                sourceDigest: sourceDigest, page: index, annotationIndex: annotationIndex, subtype: subtype, widgetType: type
            )
        )
    }
    let allWidgets = allAnnotations.enumerated().filter { _, annotation in annotationSubtype(annotation) == "widget" }
    let widgets = allWidgets.prefix(limits.maxWidgetsPerPage).map { annotationIndex, annotation in
        let type = widgetType(annotation.value(forAnnotationKey: .widgetFieldType))
        return WidgetInventory(
            fieldName: boundedString(annotation.fieldName),
            fieldType: type,
            controlKind: widgetControlKind(annotation, fieldType: type),
            flags: (annotation.value(forAnnotationKey: .widgetFieldFlags) as? NSNumber)?.intValue ?? 0,
            annotationIndex: annotationIndex,
            fingerprint: annotationFingerprint(
                sourceDigest: sourceDigest, page: index, annotationIndex: annotationIndex, subtype: "widget", widgetType: type
            )
        )
    }
    let allLinks = allAnnotations.enumerated().filter { _, annotation in annotationSubtype(annotation) == "link" }
    let links = allLinks.prefix(limits.maxAnnotationsPerPage).map { annotationIndex, annotation in
        inspectLink(annotation, annotationIndex: annotationIndex, document: document)
    }
    return PageInventory(
        index: index,
        label: boundedString(page.label) ?? String(index),
        rotation: page.rotation,
        boxes: PageBoxes(
            media: rectangle(page.bounds(for: .mediaBox)), crop: rectangle(page.bounds(for: .cropBox)),
            bleed: rectangle(page.bounds(for: .bleedBox)), trim: rectangle(page.bounds(for: .trimBox)),
            art: rectangle(page.bounds(for: .artBox))
        ),
        annotations: annotations, annotationsTruncated: allAnnotations.count > annotations.count,
        widgets: widgets, widgetsTruncated: allWidgets.count > widgets.count,
        links: links, linksTruncated: allLinks.count > links.count
    )
}

