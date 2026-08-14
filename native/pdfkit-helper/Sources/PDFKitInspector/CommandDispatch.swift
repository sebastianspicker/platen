import Foundation
import PDFKit

private func emitCommandResult(_ command: () throws -> Void) {
    do {
        try command()
    } catch let failure as InspectionFailure {
        emit(ErrorResponse(error: ErrorBody(code: failure.code)))
    } catch {
        emit(ErrorResponse(error: ErrorBody(code: InspectionFailure.invalidRequest.code)))
    }
}

private func runProtectionCommand() {
    emitCommandResult {
        let workspace = try validatedProtectionWorkspace()
        let data = try readProtectionRequestFromStandardInput()
        let request = try strictProtectionRequest(from: data)
        let input = workspace.appendingPathComponent(request.inputFilename)
        let inputData = try readPrivateInput(input)
        emit(ProtectionSuccessResponse(result: try protect(request, workspace: workspace, inputData: inputData)))
    }
}

private func runProtectionRemovalCommand() {
    emitCommandResult {
        let workspace = try validatedProtectionWorkspace()
        let data = try readProtectionRequestFromStandardInput()
        let request = try strictProtectionRemovalRequest(from: data)
        let input = workspace.appendingPathComponent(request.inputFilename)
        let inputData = try readPrivateInput(input)
        emit(ProtectionRemovalSuccessResponse(result: try removeProtection(
            request, workspace: workspace, inputData: inputData
        )))
    }
}

private func runMetadataSanitizationCommand() {
    emitCommandResult {
        let workspace = try validatedProtectionWorkspace()
        let request = try strictMetadataSanitizationRequest(from: readProtectionRequestFromStandardInput())
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(MetadataSanitizationSuccessResponse(result: try sanitizeMetadata(
            request, workspace: workspace, inputData: inputData
        )))
    }
}

private func dispatchRequestOperation(_ operation: String, data: Data, workspace: URL) throws {
    switch operation {
    case "inspect":
        let request = try strictRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        guard let document = PDFDocument(data: inputData) else { throw InspectionFailure.unreadableDocument }
        emit(SuccessResponse(result: try inspect(document, limits: request.limits, sourceData: inputData)))
    case "mutate":
        let request = try strictMutationRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(StandardMutationSuccessResponse(result: try mutate(request, workspace: workspace, inputData: inputData)))
    case "targetedMutate":
        let request = try strictTargetedMutationRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(TargetedMutationSuccessResponse(result: try targetedMutate(request, workspace: workspace, inputData: inputData)))
    case "addLocalGoToLink":
        let request = try strictLocalGoToRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(LocalGoToSuccessResponse(result: try addLocalGoToLink(request, workspace: workspace, inputData: inputData)))
    case "removeLocalGoToLink":
        let request = try strictLocalGoToRemovalRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(LocalGoToRemovalSuccessResponse(result: try removeLocalGoToLink(
            request, workspace: workspace, inputData: inputData
        )))
    case "appendOutlineBookmark":
        let request = try strictOutlineBookmarkRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(OutlineBookmarkSuccessResponse(result: try appendOutlineBookmark(
            request, workspace: workspace, inputData: inputData
        )))
    case "removeOutlineBookmark":
        let request = try strictOutlineBookmarkRemovalRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(OutlineBookmarkRemovalSuccessResponse(result: try removeOutlineBookmark(
            request, workspace: workspace, inputData: inputData
        )))
    case "renameOutlineBookmark":
        let request = try strictOutlineBookmarkRenameRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(OutlineBookmarkRenameSuccessResponse(result: try renameOutlineBookmark(
            request, workspace: workspace, inputData: inputData
        )))
    case "addLineAnnotation":
        let request = try strictLineAnnotationRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(LineAnnotationSuccessResponse(result: try addLineAnnotation(
            request, workspace: workspace, inputData: inputData
        )))
    case "addInkAnnotation":
        let request = try strictInkAnnotationRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(InkAnnotationSuccessResponse(result: try addInkAnnotation(
            request, workspace: workspace, inputData: inputData
        )))
    case "addTextFieldWidget":
        let request = try strictTextFieldWidgetRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(TextFieldWidgetSuccessResponse(result: try addTextFieldWidget(
            request, workspace: workspace, inputData: inputData
        )))
    case "applyAecMeasurement":
        let request = try strictAecMeasurementRequest(from: data)
        let inputData = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
        emit(AecMeasurementSuccessResponse(result: try aecMeasurement(
            request, workspace: workspace, inputData: inputData
        )))
    default:
        throw InspectionFailure.invalidRequest
    }
}

private func runRequestCommand(arguments: [String]) {
    guard arguments.count == 2, arguments[0] == "--request" else {
        emit(ErrorResponse(error: ErrorBody(code: InspectionFailure.invalidRequest.code)))
        return
    }
    emitCommandResult {
        let validated = try validatedWorkspace(requestPath: arguments[1])
        let data = try readPrivateRequest(validated.request)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let operation = object["operation"] as? String else { throw InspectionFailure.invalidRequest }
        try dispatchRequestOperation(operation, data: data, workspace: validated.workspace)
    }
}

func dispatchCommand() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    switch arguments {
    case ["--protect-stdin"]:
        runProtectionCommand()
    case ["--remove-protection-stdin"]:
        runProtectionRemovalCommand()
    case ["--sanitize-metadata-stdin"]:
        runMetadataSanitizationCommand()
    default:
        runRequestCommand(arguments: arguments)
    }
}
