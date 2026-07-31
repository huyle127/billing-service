import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { CustomersService } from './customers.service';
import { CustomerDto } from './dto/customer.dto';

@ApiTags('customer')
@ApiBearerAuth()
@Controller('customer')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: "The authenticated user's billing identity",
    description:
      'Returns the provider customer for this user, creating one if they do ' +
      'not have one yet.',
  })
  @ApiResponse({ status: 200, type: CustomerDto })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHENTICATED',
    type: ErrorResponseDto,
  })
  getCustomer(@CurrentUser() user: AuthenticatedUser): Promise<CustomerDto> {
    return this.customers.getCustomerView(user.userId);
  }
}
